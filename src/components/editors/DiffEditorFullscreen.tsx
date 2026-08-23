/**
 * DiffEditorFullscreen —— 文本对比的全屏 OS 窗口编辑形态（与 RichFullscreen / DiagramFullscreen 同地位）。
 *
 * 不进 FullscreenInner 那套 CodeMirror 单栏机制：对比天然是「左旧 / 右新」双栏，
 * 类型语义与单文档编辑器对不上，故在此独立分支，复用 DiffDialog 的 diff 内核
 * （useDiff 算差异 + useDiffAi 做 AI 闭环 + DiffPane 渲染 + DiffAiMenu 菜单），
 * 外层壳复用 FullscreenEditor.module.css 的工具栏 / 状态栏观感，保持与别的全屏类型一致。
 *
 * 与 DiffDialog 的差异：这里是「深编入口」——更大空间、独立窗口、可真全屏，
 * 适合长时间打磨两段文本的差异。数据经 Rust open_fullscreen_editor 的 content 字段
 * 跨窗口传入：两侧内容用 `PPDIFF::` 前缀 + JSON 编码；仅单侧（如剪贴板预填）则裸文本当左栏。
 */
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Copy, ChevronUp, ChevronDown } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useDiff } from "@/hooks/useDiff";
import { DiffPane } from "@/components/DiffPane";
import { DiffAiMenu } from "@/components/DiffAiMenu";
import { useDiffAi, type DiffSide, DIFF_AI_ACTIONS } from "@/hooks/useDiffAi";
import { FullscreenShell } from "./FullscreenShell";
import styles from "./FullscreenEditor.module.css";
import diffStyles from "../DiffDialog.module.css";

/** 跨窗口传递两侧内容的编码前缀（与 DiffDialog 的「全屏深编」按钮保持一致） */
const DIFF_FS_PREFIX = "PPDIFF::";

export function DiffEditorFullscreen({
  sourceId: _sourceId,
  initContent,
  onClose,
}: {
  /** 来源卡片 id（当前对比为自由文本，恒为 null；保留签名以对齐其它全屏类型） */
  sourceId: string | null;
  /** 跨窗口传入的内容：PPDIFF::JSON{left,right} 或裸文本（当左栏） */
  initContent: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();

  // 解析跨窗口 content：PPDIFF:: 前缀 → 双栏；否则整体当左栏。
  const decoded = useMemo(() => {
    if (initContent && initContent.startsWith(DIFF_FS_PREFIX)) {
      try {
        const p = JSON.parse(initContent.slice(DIFF_FS_PREFIX.length)) as { left?: string; right?: string };
        return { left: p.left ?? "", right: p.right ?? "" };
      } catch {
        /* 解析失败回退裸文本 */
      }
    }
    return { left: initContent ?? "", right: "" };
  }, [initContent]);

  const [mode, setMode] = useState<"line" | "word">("line");
  const [viewMode, setViewMode] = useState<"preview" | "edit">("edit");
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [currentBlock, setCurrentBlock] = useState(0);
  const [leftText, setLeftText] = useState(decoded.left);
  const [rightText, setRightText] = useState(decoded.right);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [aiTargetSide, setAiTargetSide] = useState<DiffSide>("left");

  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  // 程序化跳转期间暂停双向滚动同步，避免同步逻辑打断平滑滚动
  const jumpingRef = useRef(false);

  const { left, right, added, removed, blockCount } = useDiff({
    oldText: leftText,
    newText: rightText,
    mode,
    ignoreWhitespace: ignoreWs,
  });

  const { aiOk, runningId, run } = useDiffAi({
    leftText,
    rightText,
    onResult: (side, text) => {
      if (side === "left") setLeftText(text);
      else setRightText(text);
      setViewMode("preview");
      setCurrentBlock(0);
    },
    toast,
  });

  // 同步滚动
  const handleScroll = useCallback((source: "left" | "right") => {
    if (syncing.current || jumpingRef.current) return;
    syncing.current = true;
    const from = source === "left" ? leftRef.current : rightRef.current;
    const to = source === "left" ? rightRef.current : leftRef.current;
    if (from && to) {
      to.scrollTop = from.scrollTop;
      to.scrollLeft = from.scrollLeft;
    }
    requestAnimationFrame(() => { syncing.current = false; });
  }, []);

  // 跳转到指定差异块
  const jumpTo = useCallback((block: number) => {
    const clamped = Math.max(0, Math.min(block, blockCount - 1));
    setCurrentBlock(clamped);
    const idx = left.findIndex((l) => l.diffBlock === clamped && l.state !== "unchanged" && l.state !== "empty");
    if (idx < 0) return;
    const from = leftRef.current;
    if (!from) return;
    const lineEl = from.firstElementChild?.children[idx] as HTMLElement | undefined;
    if (!lineEl) return;
    const top = Math.max(0, lineEl.getBoundingClientRect().top - from.getBoundingClientRect().top + from.scrollTop - 60);
    jumpingRef.current = true;
    from.scrollTo({ top, behavior: "smooth" });
    rightRef.current?.scrollTo({ top, behavior: "smooth" });
    window.setTimeout(() => { jumpingRef.current = false; }, 500);
  }, [blockCount, left]);

  // 键盘：F7·Alt+↓↑ 跳转差异（与 DiffDialog 同口径；Esc 关闭由 FullscreenShell 统一处理）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (viewMode !== "preview") return;
      if (e.key === "F7" || (e.key === "ArrowDown" && e.altKey)) { e.preventDefault(); jumpTo(currentBlock + 1); }
      if ((e.key === "F7" && e.shiftKey) || (e.key === "ArrowUp" && e.altKey)) { e.preventDefault(); jumpTo(currentBlock - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jumpTo, currentBlock, viewMode]);

  const handleCopy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制${label}`, "success");
    } catch {
      toast("复制失败", "error");
    }
  }, [toast]);

  const pickAi = (actionId: string) => {
    const action = DIFF_AI_ACTIONS.find((a) => a.id === actionId);
    if (!action) return;
    void run(action, aiTargetSide);
    setAiMenuOpen(false);
  };

  const leftStats = useMemo(() => ({ lines: leftText.split("\n").length, chars: leftText.length }), [leftText]);
  const rightStats = useMemo(() => ({ lines: rightText.split("\n").length, chars: rightText.length }), [rightText]);

  // 本编辑器没有保存目标（自由文本对比，不回写卡片），但两栏文本是用户现打的——
  // 头注释说这里适合「长时间打磨两段文本的差异」，Esc 直接关窗就等于白打一场。
  // 相对传入内容有改动即视为脏，交给 FullscreenShell 的关闭守卫兜一道。
  const dirty = leftText !== decoded.left || rightText !== decoded.right;

  return (
    <FullscreenShell
      icon="🔀"
      title="文本对比"
      dirty={dirty}
      onClose={onClose}
      leftExtra={
        <>
          <div className={diffStyles.modeToggle}>
            <button
              className={`${diffStyles.modeBtn}${viewMode === "preview" ? ` ${diffStyles.modeBtnActive}` : ""}`}
              onClick={() => setViewMode("preview")}
            >预览</button>
            <button
              className={`${diffStyles.modeBtn}${viewMode === "edit" ? ` ${diffStyles.modeBtnActive}` : ""}`}
              onClick={() => setViewMode("edit")}
            >编辑</button>
          </div>
          {viewMode === "preview" && (
            <>
              <div className={diffStyles.modeToggle}>
                <button className={`${diffStyles.modeBtn}${mode === "line" ? ` ${diffStyles.modeBtnActive}` : ""}`} onClick={() => setMode("line")}>按行</button>
                <button className={`${diffStyles.modeBtn}${mode === "word" ? ` ${diffStyles.modeBtnActive}` : ""}`} onClick={() => setMode("word")}>按词</button>
              </div>
              <label className={diffStyles.ignoreWs}>
                <input type="checkbox" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} />
                忽略空白
              </label>
            </>
          )}
        </>
      }
      rightExtra={
        <>
          {aiOk && (
            <div className={diffStyles.aiWrap}>
              <button
                className={`${diffStyles.navBtn} ${diffStyles.aiBtn}`}
                onClick={() => setAiMenuOpen((v) => !v)}
                disabled={runningId !== null}
              >✦ AI</button>
              <DiffAiMenu
                open={aiMenuOpen}
                targetSide={aiTargetSide}
                setTargetSide={setAiTargetSide}
                onPick={pickAi}
                runningId={runningId}
                onClose={() => setAiMenuOpen(false)}
              />
            </div>
          )}
          {viewMode === "preview" && (
            <>
              <button className={diffStyles.navBtn} onClick={() => jumpTo(currentBlock - 1)}>
                <ChevronUp size={12} /> 上一处
              </button>
              <span className={diffStyles.navInfo}>{blockCount > 0 ? `${currentBlock + 1} / ${blockCount}` : "0 / 0"}</span>
              <button className={diffStyles.navBtn} onClick={() => jumpTo(currentBlock + 1)}>
                <ChevronDown size={12} /> 下一处
              </button>
            </>
          )}
          <button className={styles.tbBtn} onClick={() => void handleCopy(leftText, "左侧")} title="复制左侧文本">
            <Copy size={14} /> 左
          </button>
          <button className={styles.tbBtn} onClick={() => void handleCopy(rightText, "右侧")} title="复制右侧文本">
            <Copy size={14} /> 右
          </button>
        </>
      }
      statusLeft={
        <>
          <span className={styles.statusItem}>左 {leftStats.lines} 行 · {leftStats.chars} 字符</span>
          <span className={styles.statusItem}>右 {rightStats.lines} 行 · {rightStats.chars} 字符</span>
        </>
      }
      statusRight={
        <>
          <span className={styles.statusItem} style={{ color: "var(--green, #16A34A)" }}>+{added}</span>
          <span className={styles.statusItem} style={{ color: "var(--danger, #DC2626)" }}>-{removed}</span>
          <span className={styles.statusItem}>
            {blockCount > 0 ? `${currentBlock + 1} / ${blockCount}` : "0 / 0"}
          </span>
        </>
      }
    >
      {/* 列标题 */}
      <div className={diffStyles.colHeaders}>
        <div className={diffStyles.colHeader}>
          <span className={`${diffStyles.colDot} ${diffStyles.colDotOld}`} />
          左侧文本
        </div>
        <div className={diffStyles.colHeader}>
          <span className={`${diffStyles.colDot} ${diffStyles.colDotNew}`} />
          右侧文本
        </div>
      </div>

      {/* 主体：预览双栏 / 编辑双栏 */}
      <div className={styles.main}>
        {viewMode === "preview" ? (
          <div className={diffStyles.diffBody}>
            <div ref={leftRef} style={{ overflow: "auto", minHeight: 0 }} onScroll={() => handleScroll("left")}>
              <DiffPane lines={left} currentBlock={currentBlock} />
            </div>
            <div ref={rightRef} style={{ overflow: "auto", minHeight: 0 }} onScroll={() => handleScroll("right")}>
              <DiffPane lines={right} currentBlock={currentBlock} />
            </div>
          </div>
        ) : (
          <div className={diffStyles.editBody}>
            <textarea
              className={diffStyles.editArea}
              value={leftText}
              onChange={(e) => setLeftText(e.target.value)}
              placeholder="左侧文本（旧）"
              spellCheck={false}
            />
            <textarea
              className={diffStyles.editArea}
              value={rightText}
              onChange={(e) => setRightText(e.target.value)}
              placeholder="右侧文本（新）"
              spellCheck={false}
            />
          </div>
        )}
      </div>
    </FullscreenShell>
  );
}
