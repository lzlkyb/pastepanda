import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { KbDevice, KbInvite, KbInviteCreated } from "@/hooks/useKbSync";
import type { ToastFn } from "@/components/Toast";
import { CreateFlow } from "./KbPairCreate";
import type { KbJoinProps } from "./KbJoinRequests";
import { PasteFlow, RolePick, looksLikeInvite } from "./KbPairSteps";
import { readClipboardText } from "@/lib/api";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogEscape } from "@/hooks/useDialogEscape";

/**
 * 配对向导的外壳：剪贴板预读 → 选路线 → 交给 `KbPairCreate` / `KbPairSteps`。
 *
 * # 🔴 指纹核对那道门没有被向导弱化
 *
 * 「完成配对」在勾选「我已核对」之前依旧是**禁用**的（见 `PasteFlow`）。
 * 邀请码是自签的，签名只能证明「做码的人持有那把私钥」，**证明不了这个码
 * 在传给你的路上没被换掉**。真正挡住替换的是两端各自看指纹、口头核对。
 * 完整理由见 `src-tauri/src/sync/invite.rs` 的模块注释。
 * 向导只是把这道门放到更显眼的位置，绝不为了「少一步更友好」而拆它。
 *
 * # 剪贴板预读的分寸
 *
 * 只在弹窗打开那一刻 `readText()` **一次**，不常驻监听、不入库、不上报。
 * 这在本产品里是合分寸的（PastePanda 本职就是剪贴板管理器），
 * 但仍要在界面上明说「已从剪贴板读到」，让这次读取是可见的而不是悄悄发生。
 */
export function KbPairDialog({
  myFingerprint, myNodeId, defaultName, devices, joins,
  onClose, onCreateInvite, onPreview, onPair, toast,
}: {
  myFingerprint: string;
  /**
   * 本机完整 `node_id`。用它而不是指纹来认「这是不是我自己」：
   * 指纹是截短的派生物，拿它判身份理论上会撞。
   */
  myNodeId: string;
  /** 本机计算机名，给设备名当默认值。可能为空串。 */
  defaultName: string;
  /** 已配对设备（来自 5s 轮询）。生成端靠它判断对方接没接上。 */
  devices: KbDevice[];
  /**
   * 「有人敲门」的待确认队列。向导的等待屏要摆一份——
   * 弹窗盖住了下面的设置面板，不摆的话用户就只能先关掉弹窗才能确认。
   */
  joins: KbJoinProps;
  onClose: () => void;
  onCreateInvite: (name: string) => Promise<KbInviteCreated>;
  onPreview: (code: string) => Promise<KbInvite>;
  onPair: (code: string) => Promise<KbInvite>;
  toast: ToastFn;
}) {
  const [mode, setMode] = useState<"create" | "paste" | null>(null);
  const [clipCode, setClipCode] = useState("");
  /** 剪贴板预读是否还在跑（只用来给一点提示，**不再挡正文**）。 */
  const [clipChecking, setClipChecking] = useState(true);

  /**
   * 剪贴板预读：**不挡正文**。
   *
   * 🔴 改前这里 `ready` 没到就把 body 渲成空壳，而预读要等
   *   `readClipboardText` IPC，剪贴板里若像邀请码还要再 `onPreview`
   *   （验签）——弹框能空 2 秒以上（2026-09-15 实报）。
   * 现在立刻出选角色屏；预读完成后若是**别人的**邀请码再跳进粘贴流，
   * 自己的码继续留在选角色屏。
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // 走后端而不是 `navigator.clipboard.readText()`：后者会让 WebView 弹
        // 「是否允许读取剪贴板」的浏览器权限框。而这里是打开弹框就静默预读，
        // 弹框一出来尤其让人莫名其妙——用户并没请求读剪贴板。
        const t = (await readClipboardText()).trim();
        // 🔴 粗筛不过就**静默忽略**，绝不弹错：用户剪贴板里绝大多数时候
        // 是别的东西，每次打开都被骂一句是不可接受的。
        if (alive && looksLikeInvite(t)) {
          // 🔴 粗筛过了还不够，必须先解出来看是不是**本机自己的**：
          //   生成邀请码时会自动复制到剪贴板（见 KbPairCreate.handleCreate），
          //   所以「生成完 → 关掉 → 再点添加设备想加第三台」时，
          //   预读到的就是自己刚才那串。
          try {
            const inv = await onPreview(t);
            if (!alive) return;
            if (inv.node_id !== myNodeId) {
              setClipCode(t);
              setMode((m) => (m === null ? "paste" : m));
            }
            // 是自己的码 → 当作没读到，留在选角色屏。
          } catch {
            // 解不开（过期 / 残缺 / 签名不对）仍然跳进去：
            // 那是一串**长得就像邀请码**的东西，PasteFlow 里会把后端的
            // 具体原因（已过期 / 结构不对 / 签名不过）原样显出来，
            // 比静默回退有用得多（规则 #15.3）。
            if (alive) {
              setClipCode(t);
              setMode((m) => (m === null ? "paste" : m));
            }
          }
        }
      } catch {
        // 读不到剪贴板也静默：用户并没有请求这件事，留在选角色屏即可。
      }
      if (alive) setClipChecking(false);
    })();
    return () => { alive = false; };
    // ❗ 故意只跑一次，不把 `onPreview` / `myNodeId` 写进依赖：
    //   这是「弹窗打开那一刻预读一次剪贴板」，不是一个跟着 props 走的订阅。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Esc 关闭：走公共 hook（规则 #11.1，判据都收在 `hooks/useDialogEscape.ts`）。
   *
   * 🔴 之前这里手写第四份「捕获期 + `stopPropagation()`」，而复制版**已经漂移**：
   *   缺 `isComposing` 那道闸——中文输入法按 Enter 确认候选词没事，
   *   但按 Esc 收候选窗会顺手把整个配对向导关掉，刚填的设备名、刚粘的邀请码一起丢。
   *   hook 还多一条「嵌套确认框在场时让路」，判据见 `lib/modalLayers.ts`。
   *
   *   为什么必须是捕获期：App.tsx 的 Esc 分层链里有一条
   *   `if (showSettings) { closeSettings(); return; }`——本弹框从设置页打开，
   *   之前它根本没接 Esc，按下去**关掉的是整个设置页**，配对弹框跟着一起没。
   */
  useDialogEscape(onClose);

  /**
   * 🔴 portal 到 body（与 `KbForgetDialog` 同因）：DOM 父链穿过 `.settingsContent`
   * 这个滚动容器时，滚轮落在遮罩上会沿祖先链把底下的设置列表滚走；
   * `position: fixed` 管的是画在哪儿，管不了事件沿哪条 DOM 链冒泡。
   */
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      {/* ❗ `FocusTrap`：本弹框之前是全应用唯一一个漏掉它的真模态。
          不包的后果：Tab 会跑到后面的设置页上（那些控件被遮罩盖着、看不见却可聚焦），
          关闭后焦点也不会还给打开它的那个按钮。 */}
      {/* 向导每屏块数多，16px 的默认 gap 太松，收到 10px */}
      <FocusTrap>
      <div className="dialog-box dialog-solid w420" onClick={(e) => e.stopPropagation()}
        style={{ "--dialog-body-gap": "10px" } as CSSProperties}>
        <div className="dialog-header">
          {/* 术语统一：入口、标题、全程都叫「添加设备」，
              不再在「邀请另一台设备 / 添加设备 / 邀请 / 粘贴」之间换词。 */}
          <h2 className="dialog-title">添加设备</h2>
          <button onClick={onClose} className="dialog-close"><X size={16} /></button>
        </div>

        {mode === "create" ? (
          <CreateFlow defaultName={defaultName} myFingerprint={myFingerprint} devices={devices}
            joins={joins} onCreateInvite={onCreateInvite} onClose={onClose} toast={toast} />
        ) : mode === "paste" ? (
          <PasteFlow initialCode={clipCode} selfNodeId={myNodeId} onPreview={onPreview} onPair={onPair}
            onClose={onClose} toast={toast} />
        ) : (
          <>
            <RolePick onPick={setMode} />
            {/* 预读还在跑时给一行提示，避免用户以为卡住；不挡操作。 */}
            {clipChecking && (
              <div className="dialog-footer" style={{ justifyContent: "center", paddingTop: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  正在检查剪贴板是否已有邀请码…
                </span>
              </div>
            )}
          </>
        )}
      </div>
      </FocusTrap>
    </div>,
    document.body,
  );
}
