/**
 * touchClassifier — 触摸手势判定状态机（design/远程电脑-手机端-触摸语义与坐标系-设计稿 §2）。
 *
 * 纯逻辑：不碰 React、不碰 DOM、不碰 invoke——指针事件由 `useTouchGestures`
 * 喂进来，判定结果以回调发出；时钟可注入（真实环境用 performance.now +
 * setTimeout，单测用手动时钟）。手势 → 远端事件的映射在 `RcMobileSession`
 * 的回调里做，本文件只回答「这是什么手势」。
 *
 * 状态机（单指）：
 *   IDLE →(down)→ PENDING →(位移≥12px 未充能)→ MOVE（纯移动，无按键）
 *                └→(按住550ms)→ CHARGED →(位移≥12px)→ DRAG（左键拖拽）
 *                                        └→(原位抬起)→ 右键单击
 *                └→(<550ms 抬起且位移<12px)→ TAP（左键单击；320ms 内第二次 = 双击第二击）
 *   点按窗与长按窗是同一个窗（550ms）：充能前抬起都可能是一次点按，没有
 *   「防误触死窗」——该概念在接线上从未生效，2026-10-05 口径收口删除。
 * 双指：第二指落下冻结单指态（拖拽中例外：第二指整体忽略）；等待两指的
 *   起手信息，累计位移达到 10px 后分类并锁定；单指静止时最多等待 48ms。
 */
import {
  DBL_TAP_MS,
  DBL_TAP_PX,
  LONG_PRESS_MS,
  PINCH_DOMINANCE,
  TAP_MAX_PX,
  TWO_FINGER_CLASSIFY_PX,
  TWO_FINGER_SETTLE_MS,
} from "./touchConstants";

/** 判定结果的出口。坐标一律 client 坐标（CSS 像素），归一化由上层做。 */
export interface TouchCallbacks {
  /** 左键单击；isDouble = 双击的第二击（远端事件与单击完全相同，仅供反馈层用）。 */
  onTap(x: number, y: number, isDouble: boolean): void;
  /** 单指移动：指针跟随（不发任何按键）。 */
  onMoveTo(x: number, y: number): void;
  /** 长按充能达成（此刻不发任何远端事件，只给震动/视觉预告）。 */
  onCharge(x: number, y: number): void;
  /** 充能被取消（第二指冻结 / 会话取消）。 */
  onChargeCancel(): void;
  /** 充能后原位抬起 = 右键单击。 */
  onRightClick(x: number, y: number): void;
  /** 充能后开始移动 = 左键拖拽：down 已由上层在此刻发出。 */
  onDragStart(x: number, y: number): void;
  onDragMove(x: number, y: number): void;
  onDragEnd(x: number, y: number): void;
  /** 双指滚动的本帧中点位移（CSS 像素，方向 = 手指方向）。 */
  onScrollDelta(dxF: number, dyF: number, midX: number, midY: number): void;
  /** 双指分类为捏合（一次）。 */
  onPinchStart(midX: number, midY: number): void;
  /** 捏合：ratio 相对上一帧（1.0），与视野增量缩放口径一致。 */
  onPinchUpdate(ratio: number, midDxF: number, midDyF: number, midX: number, midY: number): void;
}

/** 时钟可注入：单测用手动时钟驱动 550ms 充能，不吃真实等待。 */
export interface ClassifierClock {
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
  cancel(id: unknown): void;
}

type SingleState = "idle" | "pending" | "move" | "charged" | "drag";
type TwoState = "none" | "unclassified" | "scroll" | "pinch";

export class TouchClassifier {
  private st: SingleState = "idle";
  private two: TwoState = "none";
  private readonly pointers = new Map<number, { x: number; y: number }>();
  /** 当前单指（也是拖拽指）的 pointerId：拖拽中第二指忽略后，只认这一指的移动。 */
  private dragId: number | null = null;
  private sx = 0;
  private sy = 0;
  private t0 = 0;
  private chargeTimer: unknown = null;
  private lastTapAt = -Infinity;
  private lastTapX = 0;
  private lastTapY = 0;
  private prevMidX = 0;
  private prevMidY = 0;
  private prevDist = 0;
  private twoTimer: unknown = null;
  private readonly movedPointers = new Set<number>();

  constructor(
    private readonly cb: TouchCallbacks,
    private readonly clock: ClassifierClock,
    /** 与长按充能同一窗口：充能前抬起都算点按（生产接线也传 LONG_PRESS_MS）。 */
    private readonly tapMaxMs = LONG_PRESS_MS,
    /** Local image navigation has no mouse-button ownership and must remain pinchable. */
    private readonly longPress = true,
  ) {}

  down(id: number, x: number, y: number): void {
    this.pointers.set(id, { x, y });
    if (this.pointers.size > 2) return; // 三指以上不参与任何手势
    if (this.pointers.size === 2) {
      if (this.st === "drag") return; // 左键拖拽进行中：第二指整体忽略，防拖拽被冻结后卡键
      this.cancelCharge();
      this.st = "idle"; // 冻结单指语义：双指期间③④⑤全哑（design §4.4）
      const [a, b] = [...this.pointers.values()];
      this.prevMidX = (a.x + b.x) / 2;
      this.prevMidY = (a.y + b.y) / 2;
      this.prevDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.two = "unclassified";
      this.movedPointers.clear();
      return;
    }
    this.st = "pending";
    this.sx = x;
    this.sy = y;
    this.t0 = this.clock.now();
    this.dragId = id;
    if (this.longPress) this.chargeTimer = this.clock.schedule(() => {
      this.chargeTimer = null;
      if (this.st === "pending") {
        this.st = "charged";
        this.cb.onCharge(this.sx, this.sy);
      }
    }, LONG_PRESS_MS);
  }

  move(id: number, x: number, y: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    p.x = x;
    p.y = y;
    if (this.pointers.size === 2 && this.two !== "none") {
      this.movedPointers.add(id);
      if (this.two !== "unclassified" || this.movedPointers.size === 2) this.updateTwo();
      else if (this.twoTimer === null) {
        // Pointer events arrive separately: wait for the other finger before locking intent.
        this.twoTimer = this.clock.schedule(() => {
          this.twoTimer = null;
          this.updateTwo();
        }, TWO_FINGER_SETTLE_MS);
      }
      return;
    }
    // 拖拽进行中第二指被忽略（down 时 two 保持 "none"）：拖拽指的移动必须继续流过，
    // 否则左键按住期间移动断流、抬起位置错——「拖拽中第二指不卡键」的另一半。
    if (this.pointers.size === 2 && this.two === "none") {
      if (this.st !== "drag" || id !== this.dragId) return;
    } else if (this.pointers.size !== 1) {
      return;
    }
    const dist = Math.hypot(x - this.sx, y - this.sy);
    switch (this.st) {
      case "pending":
        // 充能前移动 = 纯移动指针（无按键）。比较用「充能定时器还活着」更准，
        // 但状态即真相：pending 只在未充能时存在。
        if (dist >= TAP_MAX_PX) {
          this.cancelCharge();
          this.st = "move";
          this.cb.onMoveTo(x, y);
        }
        break;
      case "move":
        this.cb.onMoveTo(x, y);
        break;
      case "charged":
        if (dist >= TAP_MAX_PX) {
          this.st = "drag";
          this.cb.onDragStart(this.sx, this.sy);
          this.cb.onDragMove(x, y);
        }
        break;
      case "drag":
        this.cb.onDragMove(x, y);
        break;
      default:
        break;
    }
  }

  up(id: number, x: number, y: number): void {
    if (!this.pointers.delete(id)) return;
    this.cancelTwoTimer();
    const now = this.clock.now();
    // 拖拽指抬起：立即结算拖拽（即使另一指还在）——按下的左键必须有配对的 up。
    if (this.st === "drag" && id === this.dragId) {
      this.st = "idle";
      this.two = "none";
      this.dragId = null;
      this.cancelCharge();
      this.cb.onDragEnd(x, y);
      return;
    }
    if (this.pointers.size >= 1) {
      // 双指剩一指：手势终止，剩余指冻结到抬起（不补发任何事件）。
      if (this.two !== "none") this.two = "none";
      return;
    }
    const st = this.st;
    this.st = "idle";
    this.two = "none";
    this.dragId = null;
    this.cancelCharge();
    const dt = now - this.t0;
    const dist = Math.hypot(x - this.sx, y - this.sy);
    switch (st) {
      case "drag":
        this.cb.onDragEnd(x, y);
        break;
      case "charged":
        if (dist < TAP_MAX_PX) this.cb.onRightClick(this.sx, this.sy);
        else this.cb.onChargeCancel();
        break;
      case "pending":
        if (dt < this.tapMaxMs && dist < TAP_MAX_PX) {
          const isDouble =
            now - this.lastTapAt < DBL_TAP_MS &&
            Math.hypot(x - this.lastTapX, y - this.lastTapY) < DBL_TAP_PX;
          this.lastTapAt = now;
          this.lastTapX = x;
          this.lastTapY = y;
          this.cb.onTap(x, y, isDouble);
        }
        // else：超距抬起 → 无事件（转移动；长按窗内原位抬起已在上面判为点按）
        break;
      default:
        break; // move 抬起 / idle：无事件
    }
  }

  /** 全量复位（pointercancel / 失焦 / 旋转）。按键收尾由输入层 releaseAll 负责。 */
  cancelAll(): void {
    this.cancelCharge();
    this.cancelTwoTimer();
    this.pointers.clear();
    this.st = "idle";
    this.two = "none";
    this.dragId = null;
    this.lastTapAt = -Infinity;
  }

  private cancelTwoTimer(): void {
    if (this.twoTimer !== null) this.clock.cancel(this.twoTimer);
    this.twoTimer = null;
  }

  private updateTwo(): void {
    if (this.pointers.size !== 2 || this.two === "none") return;
    const [a, b] = [...this.pointers.values()];
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (this.two === "unclassified") {
      const dDist = Math.abs(dist - this.prevDist);
      const dMid = Math.hypot(midX - this.prevMidX, midY - this.prevMidY);
      if (Math.max(dDist, dMid) < TWO_FINGER_CLASSIFY_PX) return;
      this.cancelTwoTimer();
      this.two = dDist > PINCH_DOMINANCE * dMid ? "pinch" : "scroll";
      if (this.two === "pinch") this.cb.onPinchStart(midX, midY);
    }
    if (this.two === "scroll") this.cb.onScrollDelta(midX - this.prevMidX, midY - this.prevMidY, midX, midY);
    else this.cb.onPinchUpdate(dist / Math.max(1, this.prevDist), midX - this.prevMidX, midY - this.prevMidY, midX, midY);
    // Keep the starting geometry until classified: slow movement must accumulate.
    this.prevMidX = midX;
    this.prevMidY = midY;
    this.prevDist = dist;
  }

  private cancelCharge(): void {
    if (this.chargeTimer != null) {
      this.clock.cancel(this.chargeTimer);
      this.chargeTimer = null;
    }
    if (this.st === "charged") this.cb.onChargeCancel();
  }
}

/** 真实环境时钟。 */
export const realClock: ClassifierClock = {
  now: () => performance.now(),
  schedule: (fn, ms) => window.setTimeout(fn, ms),
  cancel: (id) => window.clearTimeout(id as number),
};
