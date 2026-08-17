/**
 * 两个云端类弹层：AI 处理、送动作链。
 *
 * 纯展示组件：不发请求、不碰敏感内容确认。
 * 运行/确认/复制全部回调出去，因为那些路径上有红线判断（规则 16），
 * 它们必须留在能看到全局状态的父组件里。
 */

import type { AiActionMeta } from "@/lib/api/ai";
import type { ChainDef } from "@/lib/api/chains";
import type { ChainRunResult } from "@/lib/chains/types";
import { chainNeedsAi } from "@/lib/screenshot/chains";

/** AI 弹层运行状态（三态 + 确认） */
export interface PopRun {
  status: "idle" | "running" | "ok" | "error" | "confirm";
  content?: string;
  message?: string;
  meta?: string;
  confirmReason?: string;
}

interface AiProps {
  /** 是否有可处理的 OCR 文字（影响标题提示） */
  hasText: boolean;
  res: PopRun | null;
  actions: AiActionMeta[];
  busyId: string | null;
  copied: boolean;
  onRun: (a: AiActionMeta) => void;
  /** needsConfirm 后用户点「继续」 */
  onContinue: () => void;
  onCopy: () => void;
  onClose: () => void;
}

export function AiPopover({
  hasText,
  res,
  actions,
  busyId,
  copied,
  onRun,
  onContinue,
  onCopy,
  onClose,
}: AiProps) {
  return (
    <div className="pop-layer">
      <div className="pop-head">
        <span>AI 处理识别文字{hasText ? "" : " · 无文字"}</span>
        <span className="sp" />
        <button className="xbtn" onClick={onClose}>
          ✕
        </button>
      </div>
      {res?.status === "ok" && (
        <>
          <div className="pop-result">
            <div className="meta">{res.meta}</div>
            {res.content}
          </div>
          <div className="pop-foot">
            <button className="fb primary" onClick={onCopy}>
              {copied ? "已复制 ✓" : "复制结果"}
            </button>
            <button className="fb" onClick={onClose}>
              关闭
            </button>
          </div>
        </>
      )}
      {res?.status === "running" && (
        <div className="pop-body">
          <div className="pop-empty">{res.message}</div>
        </div>
      )}
      {res?.status === "error" && (
        <>
          <div className="pop-result err">{res.message}</div>
          <div className="pop-foot">
            <button className="fb" onClick={onClose}>
              关闭
            </button>
          </div>
        </>
      )}
      {res?.status === "confirm" && (
        <>
          <div className="pop-confirm">
            ⚠️ {res.confirmReason}
            <br />
            <span style={{ opacity: 0.7, fontSize: 11 }}>继续会消耗额度并调用云端。</span>
          </div>
          <div className="pop-foot">
            <button className="fb primary" onClick={onContinue}>
              继续
            </button>
            <button className="fb" onClick={onClose}>
              取消
            </button>
          </div>
        </>
      )}
      {(!res || res.status === "idle") && (
        <div className="pop-body">
          {actions.length === 0 ? (
            <div className="pop-empty">加载动作清单中…</div>
          ) : (
            actions.map((a) => (
              <div
                key={a.id}
                className={`pop-row${busyId === a.id ? " busy" : ""}`}
                onClick={() => (busyId ? undefined : onRun(a))}
              >
                <span className="ic">{a.icon || "✦"}</span>
                <span>
                  <div className="lbl">{a.label}</div>
                  <div className="dsc">{a.description}</div>
                </span>
                <span className="net">✦ 云端</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface ChainProps {
  hasText: boolean;
  chains: ChainDef[];
  res: ChainRunResult | null;
  err: string | null;
  busyId: string | null;
  copied: boolean;
  /** AI 可用（决定含云端步骤的链是否置灰） */
  aiOk: boolean;
  onRun: (c: ChainDef) => void;
  onCopy: () => void;
  onClose: () => void;
}

export function ChainPopover({
  hasText,
  chains,
  res,
  err,
  busyId,
  copied,
  aiOk,
  onRun,
  onCopy,
  onClose,
}: ChainProps) {
  return (
    <div className="pop-layer">
      <div className="pop-head">
        <span>动作链 · 对识别文字{hasText ? "" : " · 无文字"}</span>
        <span className="sp" />
        <button className="xbtn" onClick={onClose}>
          ✕
        </button>
      </div>
      {res && (
        <>
          <div className="pop-result">
            <div className="meta">
              {res.ok
                ? "✓ 执行成功"
                : `✗ 在第 ${(res.failedAt ?? 0) + 1} 步失败：${res.stages[res.failedAt ?? 0]?.error ?? "未知错误"}`}{" "}
              · {res.stages.length} 步
            </div>
            {res.final}
          </div>
          <div className="pop-foot">
            <button className="fb primary" onClick={onCopy}>
              {copied ? "已复制 ✓" : "复制结果"}
            </button>
            <button className="fb" onClick={onClose}>
              关闭
            </button>
          </div>
        </>
      )}
      {err && (
        <>
          <div className="pop-result err">{err}</div>
          <div className="pop-foot">
            <button className="fb" onClick={onClose}>
              关闭
            </button>
          </div>
        </>
      )}
      {!res && !err && (
        <div className="pop-body">
          {chains.length === 0 ? (
            <div className="pop-empty">还没有自定义动作链，去主窗口「动作链」里创建</div>
          ) : (
            chains.map((c) => {
              // 规则 16：含云端步骤的链在 AI 未启用时不可点，并把原因写在副标题里
              // （规则 15.3：不能静默）；纯本地链不受影响。
              const blocked = !aiOk && chainNeedsAi(c);
              return (
                <div
                  key={c.id}
                  className={`pop-row${busyId === c.id ? " busy" : ""}${blocked ? " disabled" : ""}`}
                  onClick={() => (busyId || blocked ? undefined : onRun(c))}
                >
                  <span className="ic">⚡</span>
                  <span>
                    <div className="lbl">{c.name}</div>
                    <div className="dsc">
                      {blocked
                        ? "含云端步骤 · 需先在设置里开启 AI"
                        : c.description || `${c.steps.length} 步`}
                    </div>
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
