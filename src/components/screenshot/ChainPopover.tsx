/**
 * 送动作链弹层。
 *
 * 与 AI 弹层同一套外壳（几何 props + PopHead + pop-row），只差三件事：
 * 没有搜索（链通常个位数，搜索框是纯噪音）、没有推荐段（链打分尚未接入，
 * 造一个假分数比不排更糟）、含云端步骤的链在 AI 未启用时置灰并写明原因。
 */

import { Workflow } from "lucide-react";
import type { ChainDef } from "@/lib/api/chains";
import type { ChainRunResult } from "@/lib/chains/types";
import { chainNeedsAi } from "@/lib/screenshot/chains";
import { linesSub, PopFoot, PopHead, type Geometry } from "./AiPopList";

interface Props extends Geometry {
  /** 刚识别出的文字行数 */
  lines: number;
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
  left,
  top,
  maxHeight,
  lines,
  chains,
  res,
  err,
  busyId,
  copied,
  aiOk,
  onRun,
  onCopy,
  onClose,
}: Props) {
  return (
    <div className="pop-layer" style={{ left, top, maxHeight }} role="dialog" aria-label="动作链">
      <PopHead title="动作链" sub={linesSub(lines)} onClose={onClose} />
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
          <PopFoot copied={copied} onCopy={onCopy} onClose={onClose} />
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
                /* 禁用态用 aria-disabled + 现有的 JS 守卫，不用原生 disabled：
                   与截图工具栏同一口径，且「为什么不能点」就写在下一行副标题里，
                   跳过它会让人无从知道还有这么一条链。 */
                <button
                  key={c.id}
                  type="button"
                  className={`pop-row${busyId === c.id ? " busy" : ""}${blocked ? " disabled" : ""}`}
                  aria-disabled={blocked}
                  onClick={() => (busyId || blocked ? undefined : onRun(c))}
                >
                  <span className="ic">
                    <Workflow size={15} />
                  </span>
                  <span className="tx">
                    <span className="lbl">{c.name}</span>
                    <span className="dsc">
                      {blocked
                        ? "含云端步骤 · 需先在设置里开启 AI"
                        : c.description || `${c.steps.length} 步`}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
