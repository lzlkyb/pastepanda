import { useState } from "react";
import { X } from "lucide-react";
import type { KbInvite } from "@/hooks/useKbSync";
import { logger } from "@/lib/logger";

/**
 * 配对弹窗。两条路：我生成邀请码给对方，或粘贴对方的邀请码。
 *
 * # 🔴 指纹核对门
 *
 * 「完成配对」在勾选「我已与对方核对」之前是**禁用**的。
 *
 * 理由：邀请码是**自签**的——签名只能证明「做码的人持有那把私钥」，
 * **不能证明这个码在传给你的路上没被换掉**（攻击者换成自己那一份，
 * 同样自签有效、校验一样通过）。真正挡住替换的是两端各自看指纹、口头核对。
 * 同 SSH 首次连接要你敲 `yes`：一次点击的摩擦，换掉一整类中间人。
 *
 * 只在**首次配对该设备**时要求；重连不再问（重连只按已存的 node_id 重新发现地址）。
 */
export function KbPairDialog({ mode, myFingerprint, onClose, onCreateInvite, onPreview, onPair, toast }: {
  mode: "create" | "paste";
  myFingerprint: string;
  onClose: () => void;
  onCreateInvite: (name: string) => Promise<string>;
  onPreview: (code: string) => Promise<KbInvite>;
  onPair: (code: string) => Promise<KbInvite>;
  toast: (m: string, t?: "success" | "error" | "info") => void;
}) {
  const [deviceName, setDeviceName] = useState("");
  const [code, setCode] = useState("");
  const [input, setInput] = useState("");
  const [peer, setPeer] = useState<KbInvite | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    const n = deviceName.trim();
    if (!n) { toast("请先给这台设备起个名字", "error"); return; }
    setBusy(true);
    try {
      setCode(await onCreateInvite(n));
    } catch (e) {
      logger.warn("生成邀请码失败", e);
      toast(`生成邀请码失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally { setBusy(false); }
  };

  const handlePreview = async () => {
    const c = input.trim();
    if (!c) return;
    setBusy(true);
    try {
      setPeer(await onPreview(c));
      setChecked(false);
    } catch (e) {
      // 后端对每种失败给了不同的话（过期 / 被改动 / 截断），原样透出去（规则 #15.3）
      logger.warn("邀请码解析失败", e);
      toast(typeof e === "string" ? e : e instanceof Error ? e.message : "邀请码无效", "error");
      setPeer(null);
    } finally { setBusy(false); }
  };

  const handlePair = async () => {
    setBusy(true);
    try {
      const inv = await onPair(input.trim());
      toast(`已与「${inv.name}」配对，开始同步`, "success");
      onClose();
    } catch (e) {
      logger.warn("配对失败", e);
      toast(typeof e === "string" ? e : e instanceof Error ? e.message : "配对失败", "error");
    } finally { setBusy(false); }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制", "success");
    } catch {
      toast("复制失败，请手动选中复制", "error");
    }
  };

  const mono = {
    width: "100%", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11,
    padding: 8, borderRadius: 6, border: "1px solid var(--border-color)",
    background: "var(--input-bg)", color: "var(--text-primary)", resize: "none" as const,
  };
  const warnBox = {
    padding: "11px 12px", borderRadius: 9, background: "var(--orange-bg)",
    border: "1px solid var(--orange-border)", fontSize: 12,
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-box dialog-solid w420" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{mode === "create" ? "邀请另一台设备" : "添加设备"}</h2>
          <button onClick={onClose} className="dialog-close"><X size={16} /></button>
        </div>

        <div className="dialog-body">
          {mode === "create" ? (
            <>
              <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 10px" }}>
                给这台设备起个名字，对方会看到它。
              </p>
              <input className="input" placeholder="例如：书房台式机" value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                style={{ width: "100%", marginBottom: 10 }} />
              {!code ? (
                <button className="btn btn-primary" onClick={handleCreate} disabled={busy}>
                  生成邀请码
                </button>
              ) : (
                <>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 6px" }}>
                    把这串码发给你的另一台设备（微信 / 备忘录都行，<b>它本身不是秘密</b>）。7 天内有效。
                  </p>
                  <textarea readOnly value={code} rows={4} style={mono}
                    onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => copy(code)}>
                    📋 复制邀请码
                  </button>
                  <div style={{ ...warnBox, marginTop: 12 }}>
                    🔐 <b>下一步在对方那台机器上做</b>：它会显示一串指纹，确认与本机的{" "}
                    <span style={{ fontFamily: "ui-monospace, Consolas, monospace", fontWeight: 700 }}>
                      {myFingerprint}
                    </span>{" "}
                    一字不差。
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 8px" }}>
                粘贴对方生成的邀请码。
              </p>
              <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={4}
                placeholder="在这里粘贴邀请码" style={mono} />
              <button className="btn" style={{ marginTop: 8 }} onClick={handlePreview}
                disabled={busy || !input.trim()}>
                下一步：核对指纹
              </button>

              {peer && (
                <>
                  <div style={{ background: "var(--input-bg)", borderRadius: 10, padding: 12, margin: "12px 0" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>💻 {peer.name}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>它的指纹</div>
                    <div style={{
                      fontFamily: "ui-monospace, Consolas, monospace", fontSize: 15,
                      letterSpacing: 2, fontWeight: 700, color: "var(--accent-strong)",
                    }}>
                      {fingerprintOf(peer.node_id)}
                    </div>
                  </div>
                  <div style={warnBox}>
                    ⚠️ 请<b>当面或打电话</b>让对方念一遍它屏幕上的指纹。
                    <div style={{ marginTop: 6, color: "var(--text-muted)" }}>
                      邀请码是自签的——它能证明「做码的人有那把私钥」，
                      <b>但证明不了这个码在路上没被人换掉</b>。核对指纹是唯一能挡住这件事的办法。
                    </div>
                    <label style={{ display: "flex", gap: 7, marginTop: 10, fontWeight: 600, cursor: "pointer" }}>
                      <input type="checkbox" checked={checked}
                        onChange={(e) => setChecked(e.target.checked)} />
                      我已与对方核对，指纹一致
                    </label>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {mode === "paste" && (
          <div className="dialog-footer">
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={handlePair}
              disabled={!peer || !checked || busy}>
              完成配对
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 从 `node_id`（64 字符 hex）取前 4 组做短指纹，与后端
 * `NodeIdentity::fingerprint()` 必须一致：前 16 个字符按 4 分组。
 *
 * ❗ 前后端各算一遍是有意的：邀请码里只有 `node_id`，**没有指纹字段**
 * （少一个可自称的字段）。所以这里的分组规则改动时，
 * `src-tauri/src/sync/identity.rs` 里那个也要一起改。
 */
export function fingerprintOf(nodeId: string): string {
  return (nodeId.match(/.{1,4}/g) ?? []).slice(0, 4).join("-");
}
