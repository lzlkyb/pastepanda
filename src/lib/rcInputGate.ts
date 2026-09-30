/**
 * rcInputGate — 乙-③「输入权交接」的**纯判据**（前端侧）。
 *
 * 为什么单独成文件（规则 11.1）：胶囊、抽屉、出口条三处都要读同一份
 * `status.peer_input` / `status.input_pills`，而它们的措辞必须一致——
 * 「对方正在用」在一处写「对方在用」、另一处写「对端活动中」，用户就会以为
 * 是两个不同的信号。判据收在这里，组件只负责摆。
 *
 * 🔴 这个域里最容易被写反的一条：**「收回」和「锁定」动的是不同的人的手**。
 * - 收回（`host_hold`）＝被控者把自己的键鼠拿回来，挡的是**你发出去的**输入；
 * - 锁定（`lock_active`）＝你请求对方交出**他本人的物理**键鼠，不挡你发出去的输入。
 * 于是文案上绝不能把 hold 写成「对方锁定了键鼠」，也不能把 lock 写成「你被断开」。
 */
import type { RcInputActor, RcInputPills, RcPeerInputState } from "@/lib/api/rc";

/** 抽屉上一枚「谁在动」的渲染结论（`idle` 不摆，故返回 null）。 */
export interface RcInputPillView {
  key: "keyboard" | "mouse";
  /** 前缀（键盘 / 鼠标）。 */
  subject: string;
  /** 状态短语（对方正在用 / 本机在用 / 对方无权却被按下（已拦））。 */
  phrase: string;
  /** 语义色档位，颜色仍由 CSS 类决定（规则 V3：组件里不出现 hex）。 */
  tone: "peer" | "local" | "blocked";
}

const SUBJECT: Record<"keyboard" | "mouse", string> = {
  keyboard: "键盘",
  mouse: "鼠标",
};

/**
 * 三档短语。缺值（旧后端没投影 `input_pills`）按 `idle` 处理 = 不摆，
 * 而不是摆一枚「未知」——抽屉上凭空多一枚读不懂的灰点比没有更糟。
 */
const PHRASE: Record<Exclude<RcInputActor, "idle">, { phrase: string; tone: RcInputPillView["tone"] }> = {
  peer: { phrase: "对方正在用", tone: "peer" },
  local: { phrase: "本机在用", tone: "local" },
  blocked: { phrase: "对方无权却被按下（已拦）", tone: "blocked" },
};

export function rcInputPillViews(
  pills: RcInputPills | undefined | null
): RcInputPillView[] {
  const out: RcInputPillView[] = [];
  (["keyboard", "mouse"] as const).forEach((k) => {
    const actor = pills?.[k] ?? "idle";
    // 只认三个有语义的档：脏值 / 将来新加的档一律**不摆**。凭空一枚读不懂的
    // 灰点比没有更糟（而且 `PHRASE[脏值]` 展开出来是 undefined，样式会花）。
    const view = actor === "idle" ? undefined : PHRASE[actor as keyof typeof PHRASE];
    if (!view) return;
    out.push({ key: k, subject: SUBJECT[k], ...view });
  });
  return out;
}

/** 抽屉上「暂时收回我的键鼠」那颗键的文案（状态以 `input_hold` 为准，不做乐观置位）。 */
export function rcHoldButtonOf(hold: boolean | undefined): { label: string; tip: string } {
  const on = hold === true;
  return {
    label: on ? "归还键鼠给对方" : "暂时收回我的键鼠",
    tip: on
      ? "你正在自己操作这台电脑，对方发来的键鼠此刻会被拦下（画面照旧）。点一下归还。"
      : "这台电脑的键鼠先归你用：对方发来的键鼠会被拦下，画面与剪贴板不受影响。10 分钟没有本机操作会自动归还。",
  };
}

/** 抽屉上「允许对方锁定我的输入」的授权位文案（本次会话，不落盘）。 */
export function rcGrantButtonOf(
  granted: boolean | undefined,
  active: boolean | undefined
): { label: string; tip: string } {
  const on = granted === true;
  return {
    label: on ? "允许对方锁定我的输入：开" : "允许对方锁定我的输入：关",
    tip: on
      ? active
        ? "对方现在锁着你的键盘鼠标。取消勾选会立刻解开。"
        : "对方现在可以要求锁住你的键盘鼠标（锁上时你动不了本机键鼠，但远程操作照常）。授权只到本场会话结束。"
      : "勾上后对方才能要求锁住你的键盘鼠标。默认关，且这场会话结束后自动回到关——不然是「无人值守」的形状。",
  };
}

/**
 * 发起端「锁定对方」那颗键的完整状态。
 *
 * 🔴 不可点的两种原因必须分开说（都写成「不可用」= 用户不知道该催谁）：
 * - `peer_input` 缺失 → 旧版对端**根本没这个功能**，或者还没收到它的状态帧；
 * - `lock_granted === false` → 对方版本有，但他**没勾授权**。
 */
export function rcLockButtonOf(peerInput: RcPeerInputState | null | undefined): {
  on: boolean;
  enabled: boolean;
  label: string;
  tip: string;
} {
  if (!peerInput) {
    return {
      on: false,
      enabled: false,
      label: "锁定对方",
      tip: "对方未授权，或对方版本的远程还没有这个功能",
    };
  }
  if (!peerInput.lock_granted) {
    return {
      on: false,
      enabled: false,
      label: "锁定对方",
      tip: "对方没有开启「允许对方锁定我的输入」，请让对方在会话抽屉里勾上",
    };
  }
  return {
    on: peerInput.lock_active === true,
    enabled: true,
    label: peerInput.lock_active ? "解除锁定" : "锁定对方",
    tip: peerInput.lock_active
      ? "对方本人的键鼠现在锁着（你发过去的操作照常）。点此解开。"
      : "锁住对方本人的键盘鼠标（对标 RustDesk 的 block input）。他仍能在自己的屏幕上看到你在做什么，也能随时撤掉这个授权。",
  };
}

/**
 * 发起端看到的「对方收回了键鼠」提示文案（胶囊上的琥珀 pill）。
 *
 * 不写「已断开」：画面、剪贴板都还在动，被拦的只有键鼠。
 */
export function rcHostHoldPillOf(peerInput: RcPeerInputState | null | undefined): string | null {
  return peerInput?.host_hold ? "主机取回键鼠" : null;
}

/** 出口条那行常驻说明（浮条收起时它还在，规则 15.1）。 */
export function rcHostHoldOutletOf(peerInput: RcPeerInputState | null | undefined): {
  label: string;
  detail: string;
} | null {
  if (!peerInput?.host_hold) return null;
  return {
    label: "主机正在自己操作",
    detail: "你发出的键鼠会被拦下，10 分钟无操作会自动归还",
  };
}

/**
 * 乙-④：胶囊上一枚**可点**的捕获态芯片。
 *
 * 为什么要它（C6 的后半条）：Esc 一直是「指针锁 / 键盘捕获」唯一的出口，而这两个
 * 态的开关藏在「⋯」二级里——鼠标用户必须先唤出浮条、点开 ⋯ 才能放手，等于没有出口。
 * 规则 17.1 要求鼠标全流程可达，于是捕获中把那颗键提到一级，点一下就放。
 *
 * 🔴 两态同时成立时**指针锁优先**：锁着的时候系统光标被藏在画面里，键盘芯片点不到，
 * 先解眼前这一层。放完指针锁，下一次渲染自然轮到键盘芯片——不是一条文案里塞两件动作。
 *
 * 只看档（`canControl === false`）返回 null：它根本没有捕获能力，摆一枚「键盘捕获中」
 * 是在说谎（规则 V：状态显示必须有对应真值）。
 */
export function rcCaptureChipOf(a: {
  canControl: boolean;
  pointerLocked: boolean;
  kbOn: boolean;
}): { action: "pointer" | "keyboard"; label: string; tip: string } | null {
  if (!a.canControl) return null;
  if (a.pointerLocked) {
    return {
      action: "pointer",
      label: "指针锁定中",
      tip: "鼠标已被捕获在画面里，本地光标看不见。点此解锁（Esc 同效），解锁后键盘捕获仍在。",
    };
  }
  if (a.kbOn) {
    return {
      action: "keyboard",
      label: "键盘捕获中",
      tip: "你敲的每个键都进对方机器，本机输入法不再拿到它们。点此释放（Esc 同效）。",
    };
  }
  return null;
}
