/**
 * NoteConflictView.tsx —— 冲突副本的对照与采用（W4a）。
 *
 * 设计稿：`design/知识库冲突对照-设计稿.html`
 *
 * # 位置与形状同 [`NoteHistoryView`]
 *
 * **不叠弹窗、不开侧栏**，而是把编辑区换成它。两个理由：
 * 一是窗口 `minWidth` 只有 320px（`tauri.conf.json`），再叠弹窗没地方；
 * 二是它要的宿主接线（采用后把新内容写回编辑器、切回编辑视图）
 * 与版本历史一模一样，现成。
 *
 * # 不自己写 diff
 *
 * `useDiff` + `DiffPane` 已经在那里（`DiffDialog` 用的同一套）。
 * 只不搬“编辑模式”与 AI 菜单两块：前者在这里没意义（要改就回编辑器改），
 * 后者是有意不接 —— 两侧都是用户自己写的东西，让模型提一个“合并建议”
 * 很容易被当成结论直接采用。日后要加必须受 AI 开关控制（规则 #16）。
 *
 * # 🔴 为何列头不写「本机版 / 对端版」
 *
 * 副本正文里那句「来自本机/对端那一份」是**建副本那台机器**写下的。
 * 而副本自己会同步过去 —— 于是在另一台上读到的「本机」指的却是对方。
 * 副本里没带 node id，本组件无法分辨，所以列头只用在两台上都成立的说法：
 * 「当前保留的」与「副本里那一份」。原句仍在副本正文里，用户刚才就在看。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp } from "lucide-react";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import { useDiff, type DiffMode } from "@/hooks/useDiff";
import { DiffPane } from "@/components/DiffPane";
import { parseConflictCopy, type ConflictCopy } from "@/lib/kbConflict";
import { noteGet, noteUpdate, noteDelete, type Note } from "@/lib/api";
import styles from "./NoteConflictView.module.css";

/** 一段居中的说明 + 返回。几条降级路径长得一样，抽出来。 */
function Fallback({ text, onBack }: { text: string; onBack: () => void }) {
  return (
    <div style={{ padding: "18px 16px", fontSize: 13, color: "var(--text-secondary)" }}>
      <p style={{ margin: "0 0 12px" }}>{text}</p>
      <button type="button" className={styles.back} onClick={onBack}>
        <ArrowLeft size={13} /> 返回编辑
      </button>
    </div>
  );
}

export function NoteConflictView({
  copyId,
  copyContent,
  onBack,
  onResolved,
}: {
  /** 这篇副本的 id——处理完要把它移到回收站。 */
  copyId: string;
  /**
   * 副本正文。
   *
   * ❗ 传**编辑器里的当前值**而不是库里的（同 `NoteHistoryView`）：
   * 用户可能刚在副本里动过手，解的得是他眼前那份。
   */
  copyContent: string;
  onBack: () => void;
  /**
   * 已处理完（副本已进回收站）。参数是原笔记 id，方便宿主跳过去。
   *
   * ❗ 宿主必须自己收尾：当前打开的那篇（副本）已经不在了。
   */
  onResolved: (originId: string) => void;
}) {
  const { toast } = useToast();
  const [mode, setMode] = useState<DiffMode>("line");
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [currentBlock, setCurrentBlock] = useState(0);
  const [busy, setBusy] = useState(false);
  /** `undefined` = 还在拉；`null` = 原笔记不在了。 */
  const [origin, setOrigin] = useState<Note | null | undefined>(undefined);
  const leftRef = useRef<HTMLDivElement>(null);

  const parsed: ConflictCopy | null = useMemo(
    () => parseConflictCopy(copyContent),
    [copyContent],
  );

  useEffect(() => {
    if (!parsed) {
      setOrigin(null);
      return;
    }
    let alive = true;
    void (async () => {
      const n = await noteGet(parsed.originId);
      if (alive) setOrigin(n);
    })();
    return () => {
      alive = false;
    };
  }, [parsed]);

  // hooks 不能有条件，所以缺值时拿空串算（结果用不到，下面会先降级返回）。
  const { left, right, added, removed, blockCount } = useDiff({
    // ❗ 两侧都去尾换行。`losingContent` 已经去过（见 `kbConflict`），
    //   这边不去的话就只差一个尾空行也会报一处差异。
    oldText: (origin?.content ?? "").replace(/\n+$/, ""),
    newText: parsed?.losingContent ?? "",
    mode,
    ignoreWhitespace: ignoreWs,
  });

  // 上一处 / 下一处：除了改高亮，还要把那一行滚进视野——否则按钮只改颜色，
  // 在长笔记里等于没用。拿容器里的 `.currentDiff` 找，不需要 DiffPane 开 ref。
  const jumpTo = useCallback(
    (next: number) => {
      if (blockCount === 0) return;
      const b = ((next % blockCount) + blockCount) % blockCount;
      setCurrentBlock(b);
      requestAnimationFrame(() => {
        leftRef.current
          ?.querySelector("[class*='currentDiff']")
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    },
    [blockCount],
  );

  const adopt = async () => {
    if (!parsed || !origin) return;
    const ok = await confirmDialog({
      title: "用副本那一份替换原笔记",
      // 确认框是纯文本渲染，不要写 Markdown 星号。
      message:
        `把《${origin.title}》的正文换成副本里那一份。\n` +
        `原来的正文会进版本历史（找得回），并在下一轮同步时推给其它设备。`,
      confirmText: "替换",
      variant: "warning",
    });
    if (!ok) return;
    setBusy(true);
    // 🔴 顺序：先写原笔记、再删副本。反过来的话副本删了而写失败，
    //    那份内容就只在回收站里了。现在的顺序下删失败只是副本还在，可重试。
    //
    // 标题用**原笔记现在的**：这里采用的是正文，不连带换标题
    // （副本 frontmatter 里那个标题是当时的快照，拿它覆盖会让人意外）。
    if (!(await noteUpdate(origin.id, origin.title, parsed.losingContent))) {
      setBusy(false);
      return; // 错已弹过
    }
    if (!(await noteDelete(copyId))) {
      setBusy(false);
      return;
    }
    toast("已用副本那一份，副本已移到回收站");
    onResolved(origin.id);
  };

  const keepCurrent = async () => {
    if (!parsed) return;
    setBusy(true);
    if (!(await noteDelete(copyId))) {
      setBusy(false);
      return;
    }
    toast("已保留当前版本，副本已移到回收站");
    onResolved(parsed.originId);
  };

  if (!parsed) {
    return (
      <Fallback
        onBack={onBack}
        text="这篇里找不到「原笔记 id」那一行（可能已经被编辑掉了），所以无法自动对照。你仍可以直接编辑这两篇自己拼。"
      />
    );
  }
  if (origin === undefined) {
    return <Fallback onBack={onBack} text="正在拉原笔记……" />;
  }
  if (origin === null) {
    return (
      <Fallback
        onBack={onBack}
        text={`原笔记（id ${parsed.originId.slice(0, 8)}…）不在了——可能已被删，也可能还没同步过来。副本里的内容没丢，就在本篇正文里。`}
      />
    );
  }

  const colHead = (which: "cur" | "copy") => (
    <div className={styles.head}>
      <span
        className={styles.dot}
        style={{ background: which === "cur" ? "var(--accent)" : "var(--orange)" }}
      />
      {which === "cur" ? "当前保留的（原笔记）" : "副本里那一份"}
    </div>
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.head} style={{ padding: "7px 12px", fontSize: 12.5 }}>
        <button type="button" className={styles.back} onClick={onBack}>
          <ArrowLeft size={13} /> 返回
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--green)" }}>+{added}</span>
        <span style={{ color: "var(--danger)" }}>-{removed}</span>
      </div>

      <div className={styles.head}>
        <button type="button" className={styles.btn} onClick={() => setMode(mode === "line" ? "word" : "line")}>
          {mode === "line" ? "按行" : "按词"}
        </button>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} />
          忽略空白
        </label>
        <span style={{ flex: 1 }} />
        <button type="button" className={`${styles.btn} ${styles.btnTiny}`} onClick={() => jumpTo(currentBlock - 1)} disabled={blockCount === 0}>
          <ChevronUp size={12} />
        </button>
        <span>{blockCount > 0 ? `${currentBlock + 1} / ${blockCount}` : "0 / 0"}</span>
        <button type="button" className={`${styles.btn} ${styles.btnTiny}`} onClick={() => jumpTo(currentBlock + 1)} disabled={blockCount === 0}>
          <ChevronDown size={12} />
        </button>
      </div>

      {/* 宽的时候用这一行两列；窄的时候它隐起来，每栏用自带的列头 */}
      <div className={styles.wideHead}>
        {colHead("cur")}
        {colHead("copy")}
      </div>

      <div className={styles.body}>
        <div className={styles.col}>
          <div className={styles.stackHead}>{colHead("cur")}</div>
          <div ref={leftRef} className={styles.scroll}>
            <DiffPane lines={left} currentBlock={currentBlock} />
          </div>
        </div>
        <div className={styles.col}>
          <div className={styles.stackHead}>{colHead("copy")}</div>
          <div className={styles.scroll}>
            <DiffPane lines={right} currentBlock={currentBlock} />
          </div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          padding: "9px 12px",
          borderTop: "1px solid var(--border-color)",
        }}
      >
        <button type="button" className={styles.btn} onClick={adopt} disabled={busy}>
          用副本那一份
        </button>
        <button type="button" className={styles.btn} onClick={keepCurrent} disabled={busy}>
          保留当前版
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className={styles.btn} onClick={onBack} disabled={busy}>
          手动拼
        </button>
      </div>
    </div>
  );
}
