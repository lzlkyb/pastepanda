import { useEffect, useState } from "react";
import { Check, Copy, ClipboardPaste, Loader2, Pencil, Play, Square } from "lucide-react";
import { pasteTextGuarded } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { logActionEvent } from "@/lib/api/actionEvents";
import type { useChainWorkspace } from "@/hooks/useChainWorkspace";
import styles from "../ChainRunnerDialog.module.css";

export function ChainFooter({ workspace: w, inputIssue }: { workspace: ReturnType<typeof useChainWorkspace>; inputIssue: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  const r = w.run.result;
  useEffect(() => { setCopied(null); }, [r]);
  const log = (outcome: "copied" | "pasted") => {
    if (w.selected) logActionEvent({ actionId: w.selected.id, contentType: "chain", sourceApp: "", hour: new Date().getHours(), outcome });
  };
  const copy = async () => {
    if (!r || !r.final) return;
    try { await navigator.clipboard.writeText(r.final); setCopied(r.final); log("copied"); toast(r.ok ? "已复制结果" : "已复制保留内容", "success"); }
    catch { toast("复制失败，请重试", "error"); }
  };
  const paste = async () => {
    if (r?.ok && r.final) { if (await pasteTextGuarded(r.final)) { log("pasted"); toast("已粘贴到前台", "success"); } }
  };
  let buttons, hint;
  if (w.run.pending) {
    buttons = <><button className={styles.secondary} onClick={w.run.stop}>停止后续步骤</button><button className={styles.primary} onClick={() => w.run.pending?.respond(true)}>确认并发送这一步</button></>;
    hint = "仅确认当前步骤，不默认授权后续发送。";
  } else if (w.run.running && !r) {
    buttons = <button className={styles.secondary} onClick={w.run.stop}><Square size={13} />停止后续步骤</button>;
    hint = "不会启动新的步骤。已发出的请求可能仍完成并计入用量。";
  } else if (r) {
    buttons = <>
      <button className={styles.secondary} disabled={w.run.running} onClick={() => { setCopied(null); if (r.ok) void w.run.run(); else w.edit(); }}>
        {w.run.running ? <Loader2 size={13} className="spin" /> : <Pencil size={13} />}{w.run.running ? "正在停止…" : r.ok ? "重新运行" : "调整后重跑"}
      </button>
      <button className={styles.primary} disabled={!r.final} onClick={() => void copy()}>{copied === r.final ? <Check size={13} /> : <Copy size={13} />}
        {copied === r.final ? "已复制" : r.ok ? "复制结果" : r.stages.some(s => s.ok && !s.skipped) ? "复制已完成部分" : "复制原文"}</button>
      {r.ok && <button className={styles.secondary} disabled={!r.final} onClick={() => void paste()}><ClipboardPaste size={13} />粘贴到前台</button>}
    </>;
    hint = r.ok ? "操作后保留结果，不会自动关闭。" : "部分内容不作为最终结果直接粘贴；重跑将从第一步开始。";
  } else if (w.view === "ai") {
    buttons = w.planner.loading ? <button className={styles.secondary} onClick={w.planner.stop}>停止等待</button> :
      <button className={styles.primary} disabled={!w.planner.goal.trim() || !w.input.trim() || !!w.planner.needsConfirm} onClick={() => void w.planner.generate()}>生成步骤并发送</button>;
    hint = !w.input.trim() ? "请先在当前内容中填写文字。" : !w.planner.goal.trim() ? "先写一句你想得到的结果。" : "发送目标与已预览的文字；生成后不会自动运行。";
  } else if (w.view === "review" && w.selected) {
    buttons = <><button className={styles.secondary} onClick={() => w.edit()}><Pencil size={13} />调整步骤</button>
      <button className={styles.primary} disabled={!!inputIssue || w.selected.steps.length === 0 || w.selected.corrupted} onClick={() => { setCopied(null); void w.run.run(); }}><Play size={13} />运行这 {w.selected.steps.length} 步</button></>;
    hint = inputIssue || w.warnings.join(" ") || (w.selected.id === "web-to-text" && !/<[^>]+>/.test(w.input)
      ? "当前没有网页标签，这个流程可能不会改变内容。也可换个流程。" : "结果先预览，不会自动复制或粘贴。");
  } else { buttons = <button className={styles.primary} disabled>先选择一个流程</button>; hint = "选择后会展示步骤，不会立即运行。"; }
  return <footer className={styles.footer}><div className={styles.actions}>{buttons}</div><p>{hint}</p></footer>;
}
