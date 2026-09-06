import { useEffect, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import type { KbDevice, KbInvite, KbInviteCreated } from "@/hooks/useKbSync";
import type { ToastFn } from "@/components/Toast";
import { CreateFlow } from "./KbPairCreate";
import type { KbJoinProps } from "./KbJoinRequests";
import { PasteFlow, RolePick, looksLikeInvite } from "./KbPairSteps";
import { readClipboardText } from "@/lib/api";
import { FocusTrap } from "@/components/FocusTrap";

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
  /** 预读完成前不渲染正文，否则会先闪一下选角色屏再跳走。 */
  const [ready, setReady] = useState(false);

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
          //   以前直接跳进粘贴流程，等 PasteFlow 里 preview 回来才报
          //   「这是本机自己的邀请码」——用户本意是添加设备，却被一个
          //   错误页接住了（2026-09-06 真实反馈）。判断得提到**跳转之前**。
          try {
            const inv = await onPreview(t);
            if (!alive) return;
            if (inv.node_id !== myNodeId) {
              setClipCode(t);
              setMode("paste");
            }
            // 是自己的码 → 当作没读到，静默落到选角色屏。
            // 不提示：用户点的是「添加设备」，不是来看一条关于剪贴板的报告。
          } catch {
            // 解不开（过期 / 残缺 / 签名不对）仍然跳进去：
            // 那是一串**长得就像邀请码**的东西，PasteFlow 里会把后端的
            // 具体原因（已过期 / 结构不对 / 签名不过）原样显出来，
            // 比静默回退有用得多（规则 #15.3）。
            if (alive) {
              setClipCode(t);
              setMode("paste");
            }
          }
        }
      } catch {
        // 读不到剪贴板也静默：用户并没有请求这件事，降级到选角色屏即可。
        // （他主动点「读取剪贴板」时失败是要报的，见 `PasteFlow.readClip`）
      }
      if (alive) setReady(true);
    })();
    return () => { alive = false; };
    // ❗ 故意只跑一次，不把 `onPreview` / `myNodeId` 写进依赖：
    //   这是「弹窗打开那一刻预读一次剪贴板」，不是一个跟着 props 走的订阅。
    //   `onPreview` 来自父层，它一旦不是稳定引用，写进去就会变成
    //   **每次重渲染都重读一遍剪贴板**——而读剪贴板正是本文件头部
    //   反复强调要有分寸的那件事。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Esc 关闭。
   *
   * 🔴 必须是**捕获期 + `stopPropagation()`**，照 `NoteDialog` 的写法（规则 #11）。
   *   本弹框是从设置页打开的，而 App.tsx 的 Esc 分层链里有一条
   *   `if (showSettings) { closeSettings(); return; }`——之前本弹框根本没接 Esc，
   *   按下去**关掉的是整个设置页**，配对弹框跟着一起没了。
   *   光加个冒泡期监听也不行：两个监听器都在 window 上，App 那份注册得更早，
   *   会先跑，`preventDefault()` 拦不住同级监听器。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
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

        {!ready ? (
          <div className="dialog-body" style={{ minHeight: 120 }} />
        ) : mode === "create" ? (
          <CreateFlow defaultName={defaultName} myFingerprint={myFingerprint} devices={devices}
            joins={joins} onCreateInvite={onCreateInvite} onClose={onClose} toast={toast} />
        ) : mode === "paste" ? (
          <PasteFlow initialCode={clipCode} selfNodeId={myNodeId} onPreview={onPreview} onPair={onPair}
            onClose={onClose} toast={toast} />
        ) : (
          <RolePick onPick={setMode} />
        )}
      </div>
      </FocusTrap>
    </div>
  );
}
