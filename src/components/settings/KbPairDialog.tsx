import { useEffect, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import type { KbDevice, KbInvite, KbInviteCreated } from "@/hooks/useKbSync";
import type { ToastFn } from "@/components/Toast";
import { CreateFlow } from "./KbPairCreate";
import { PasteFlow, RolePick, looksLikeInvite } from "./KbPairSteps";

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
  myFingerprint, defaultName, devices, onClose, onCreateInvite, onPreview, onPair, toast,
}: {
  myFingerprint: string;
  /** 本机计算机名，给设备名当默认值。可能为空串。 */
  defaultName: string;
  /** 已配对设备（来自 5s 轮询）。生成端靠它判断对方接没接上。 */
  devices: KbDevice[];
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
        const t = (await navigator.clipboard.readText()).trim();
        // 🔴 粗筛不过就**静默忽略**，绝不弹错：用户剪贴板里绝大多数时候
        // 是别的东西，每次打开都被骂一句是不可接受的。
        if (alive && looksLikeInvite(t)) {
          setClipCode(t);
          setMode("paste");
        }
      } catch {
        // 读不到剪贴板也静默：用户并没有请求这件事，降级到选角色屏即可。
        // （他主动点「读取剪贴板」时失败是要报的，见 `PasteFlow.readClip`）
      }
      if (alive) setReady(true);
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      {/* 向导每屏块数多，16px 的默认 gap 太松，收到 10px */}
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
            onCreateInvite={onCreateInvite} onClose={onClose} toast={toast} />
        ) : mode === "paste" ? (
          <PasteFlow initialCode={clipCode} onPreview={onPreview} onPair={onPair}
            onClose={onClose} toast={toast} />
        ) : (
          <RolePick onPick={setMode} />
        )}
      </div>
    </div>
  );
}
