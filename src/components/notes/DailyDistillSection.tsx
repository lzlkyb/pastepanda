/**
 * 今日蒸馏（P1）——把当天的剪贴板碎片聚成几篇**草稿**。
 *
 * # 为什么不写进 `KbInboxPanel`
 *
 * 两者回答的是不同问题：待沉淀答「**这一条**值不值得留」，
 * 蒸馏答「**这一堆**合起来值不值得留」。而且待沉淀为空时整个面板不渲染，
 * 写进去就会变成「没候选就也看不到蒸馏」——而那正是最需要它的时候。
 *
 * # 🔴 三条红线
 *
 * 1. **不自动落库**：采纳只是把草稿预填进笔记弹窗，存不存你说了算（守 D13）。
 * 2. **不做全文搬运**：摄录由后端夹到 60 字，前端拿不到全文。
 * 3. **产出上限**：每天最多 3 篇（`MAX_DRAFTS_PER_DAY`）。
 *
 * # P3：「AI 成文」是手动的，不是自动的
 *
 * P1/P2 只能「聚」（纯词面，离线、零成本），点了那个按钮才「炼」。
 * 发出去的就是卡片上已经渲染给你看过的那几行，**不多一个字**；
 * 不点就一分钱不花、一个字节不出网。详见 `runAi`。
 *
 * # 默认折叠，与待沉淀同构
 *
 * 初版没做折叠（横幅是个 `<div>`），行换成卡片后就出事了：
 * 中栏只有 `.listWrap` 一层会滚，而本区块是 `flex-shrink: 0`，
 * 展开时它占的 ~270px 一分不让——窗口一矮笔记列表就没高度了，
 * 体感是「页面不能滑动」而不是「区块太大」。
 *
 * ❗ 折叠的代价是不点就看不见草稿，所以横幅必须报数（「可蒸馏 N 篇」）；
 * 也因此数据不能像待沉淀那样延到展开才查——那个 N 聚完才知道。
 *
 * # ⚠ 采纳后草稿不会自己消失
 *
 * 因为我们**无法知道你在弹窗里到底存没存**。两个选择：
 * ① 一点采纳就标记已处理——你若取消了，草稿当天静默消失；
 * ② 只有你明确点「忽略」才消失——代价是存完之后它还在那儿。
 * 选了②：**多一行可见的冗余，好过一条静默消失的内容**。
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Sparkles, Undo2, Wand2 } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { historyDayExcerpts, historyRecentExcerpts, toIsoDate } from "@/lib/api/dailyBrief";
import {
  buildDailyDrafts,
  buildDistillPayload,
  buildTopicDrafts,
  parseDistillResult,
  previewOfText,
  TOPIC_LOOKBACK_DAYS,
  type DistillDraft,
} from "@/lib/notes/distill";
import { noteCreate, noteDelete } from "@/lib/api/notes";
import { useNoteDialogClosed } from "@/hooks/useNoteDialogClosed";
import { useFirstSight } from "@/hooks/useFirstSight";
import { aiRun } from "@/lib/api/ai";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { budgetExceededMessage } from "@/lib/aiBudgetMsg";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import styles from "./KbInboxPanel.module.css";

/**
 * 忽略记录放 `localStorage` 而不建表。
 *
 * 它是**当天有效**的 UI 状态，不是数据：过了今天就无意义了。
 * 为它建表还得配一套清理策略，而那正是 `daily_brief` 表被拍板不建的理由。
 * 代价：不跨机同步。可接受——在另一台机器上重新看到今天的草稿不算损失。
 */
function dismissKey(date: string): string {
  return `pp.distill.dismissed.${date}`;
}

function loadDismissed(date: string): Set<string> {
  try {
    const raw = localStorage.getItem(dismissKey(date));
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(date: string, set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(dismissKey(date), JSON.stringify([...set]));
  } catch (e) {
    logger.warn("蒸馏处理记录写入失败", e);
  }
}

/**
 * 上一步做了什么，给撤销用。
 *
 * 两种都要把 `key` 从 dismissed 里拿出来；采纳还多一步把刚建的笔记删掉。
 * 删走 `noteDelete` 而不是彻底抹掉：进回收站，万一其中一篇你其实想留。
 */
type LastAction =
  | { kind: "dismiss"; drafts: DistillDraft[] }
  | { kind: "adopt"; drafts: DistillDraft[]; noteIds: string[] };

/**
 * 撤销条多久后自己走。
 *
 * 6 秒是 Gmail 那条「已存档 · 撤销」的量级：够看清一句话并伸手点一下，
 * 又不至于挂在界面上碍事。旧实现**没有任何自动清除**，
 * 做完一次批量采纳，界面反而多了一行要你再点一次的东西。
 *
 * ❗ 错过也不丢东西：采纳那条的笔记就在库里（删一下就是，进回收站），
 * 忽略那条更轻——只是 localStorage 里一个 key。
 */
const UNDO_AUTO_HIDE_MS = 6000;

export function DailyDistillSection() {
  const today = toIsoDate(new Date());
  const [drafts, setDrafts] = useState<DistillDraft[]>([]);
  /**
   * 默认**折叠**，与待沉淀同构。
   *
   * 中栏只有 `.listWrap` 一层会滚，而本区块是 `flex-shrink: 0`：
   * 它展开时占的 ~270px 一分不让，窗口一矮笔记列表就没高度了。
   *
   * ❗ 数据仍在挂载时就查（不像待沉淀那样延到展开）：
   * 横幅要报「可蒸馏 N 篇」，而那个 N 就是聚完才知道的。
   */
  const [expanded, setExpanded] = useState(false);
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  /** 鼠标在撤销条上。悬停就暂停倒计时——见 `UNDO_AUTO_HIDE_MS` 的 effect。 */
  const [undoHover, setUndoHover] = useState(false);
  /** 正在成文的那篇的 key。同时只允许一篇——每一次都花用户的钱 */
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  /** 已经被 AI 重写过的那几篇。卡片上要标出来，否则你分不清哪篇花过钱 */
  const [aiDone, setAiDone] = useState<ReadonlySet<string>>(new Set());
  /** 批量成文的进度。`null` = 没在跑 */
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  /**
   * 批量存入的进度。`null` = 没在跑。
   *
   * 🔴 它同时堆两件事，缺一不可：
   * ① **并发闸**——`adoptAll` 是串行建 N 篇的 async，之前三个批量按钮只看
   *    `batch`/`aiBusy`，那两个在存入时都是 null，于是**双击就会跑两遍、
   *    建出 2N 篇重复笔记**；
   * ② **U1 进度**——存 5 篇轻松超过 1 秒，而之前整个过程界面零变化。
   */
  const [adopt, setAdopt] = useState<{ done: number; total: number } | null>(null);
  const openNote = useDialogStore((s) => s.openNote);
  const { toast } = useToast();
  // L4：第一次真的聚出东西时解释一句。空的时候不说（那是 L3，不适用）
  const showFirstHint = useFirstSight("distill", drafts.length > 0);

  const reload = useCallback(async () => {
    const dismissed = loadDismissed(today);
    // 两条管线并行拉：P1 只看今天，P2 要回看一周。
    // 各自独立限量（3 + 2），合起来才不会淹——见 distill.ts 的红线③。
    const [dayRows, weekRows] = await Promise.all([
      historyDayExcerpts(today),
      historyRecentExcerpts(TOPIC_LOOKBACK_DAYS),
    ]);
    setDrafts([
      ...buildDailyDrafts(dayRows, today, dismissed),
      ...buildTopicDrafts(weekRows, dismissed),
    ]);
  }, [today]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 笔记弹窗关了就重算：存了的话那些卡片可能已经不再是候选。
  useNoteDialogClosed(reload);

  // 撤销条到点自毁。悬停时不排定时器（= 暂停）：
  // 正把鼠标移过去要点「撤销」、条却自己没了，是最气人的一种交互。
  // 离开后重新计满 6 秒而不是接着跑，对用户更宽容。
  useEffect(() => {
    if (!lastAction || undoHover) return;
    const t = setTimeout(() => setLastAction(null), UNDO_AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [lastAction, undoHover]);

  const dismissMany = useCallback(
    (ds: DistillDraft[]) => {
      if (ds.length === 0) return;
      const set = loadDismissed(today);
      ds.forEach((d) => set.add(d.key));
      saveDismissed(today, set);
      setLastAction({ kind: "dismiss", drafts: ds });
      setDrafts((cur) => cur.filter((x) => !ds.some((d) => d.key === x.key)));
    },
    [today],
  );

  /**
   * 一键采纳：直接落库，**不开弹窗**。
   *
   * 与单篇「采纳为笔记」是两个意思，故意分开：
   *   单篇 = 我要改改再存 → 弹窗预填
   *   一键 = 原样收下   → 直接存
   * 这也顺手解掉了一个老问题：弹窗那条路我们不知道你到底存没存，
   * 所以草稿不能消失；而这条路**确知存了**，就能消失。
   *
   * ❗ 必须同时写进 dismissed：不写的话下一次重算又会把同一簇聚出来
   * （笔记没挂 history_id——一篇是 N 条聚的，挂到任何一条上都是假的归属）。
   */
  const adoptAll = useCallback(async () => {
    const picked = drafts;
    // ❗ `adopt !== null` 是并发闸：按钮 disabled 拦不住已经发出去的第二次点击
    if (picked.length === 0 || adopt !== null) return;
    setAdopt({ done: 0, total: picked.length });
    const noteIds: string[] = [];
    try {
      for (const [i, d] of picked.entries()) {
        const n = await noteCreate(null, d.title, d.content);
        if (n) noteIds.push(n.id);
        setAdopt({ done: i + 1, total: picked.length });
      }
    } finally {
      setAdopt(null);
    }
    if (noteIds.length === 0) return; // 一篇都没建成，错已经弹过了
    // ❗ U3 部分成功：建成几篇就报几篇，不抹成全成功
    const set = loadDismissed(today);
    picked.forEach((d) => set.add(d.key));
    saveDismissed(today, set);
    setLastAction({ kind: "adopt", drafts: picked, noteIds });
    setDrafts([]);
  }, [drafts, today, adopt]);

  /**
   * P3：把这一簇摘录发给**用户自己配的** AI，写成一篇草稿。
   *
   * 🔴 三条红线：
   * 1. **只能手动触发**——后台批量跑 = 烧用户的钱 + 无声出网，两条都踩；
   * 2. **仍不落库**——模型写完只是**写回草稿**，存不存仍然你说了算；
   * 3. **三态全接**——needsConfirm / budgetExceeded / truncated 各自有说法。
   *
   * ❗ 结果写回草稿而不是直接 `openNote`：批量成文时不可能弹 N 个窗，
   * 而单篇与批量必须是同一件事——否则「AI 成文」一个按钮两个意思。
   * 改完你在卡片上就能看到新标题与新预览，再决定采纳还是忽略。
   *
   * 命名函数表达式（`run`）是为了 needsConfirm 后能递归重发：
   * force 只能由用户在 toast 上按出来，**绝不自动重发**。
   *
   * 返回值给批量用：`false` = 别再往下跑了。
   */
  const runAi = useCallback(
    async function run(d: DistillDraft, force = false): Promise<boolean> {
      if (!isAiAvailable()) {
        toast("请先在设置里配置 AI", "info");
        return false;
      }
      setAiBusy(d.key);
      try {
        // 载荷只含已被夹到 60 字的摘录（见 buildDistillPayload 的红线）
        const r = await aiRun("ai-distill-draft", buildDistillPayload(d), undefined, force);
        if (r.status === "ok" && r.content.trim()) {
          // 截断必须说出来：不说，用户会把「断在半句」当成模型水平差
          if (r.truncated) toast("写到上限被截断了，采纳后请自己补个结尾", "info", 6000);
          const parsed = parseDistillResult(r.content, d.title);
          setDrafts((cur) =>
            cur.map((x) =>
              x.key === d.key
                ? {
                    ...x,
                    title: parsed.title,
                    content: parsed.content,
                    preview: previewOfText(parsed.content),
                  }
                : x,
            ),
          );
          setAiDone((cur) => new Set(cur).add(d.key));
          return true;
        }
        if (r.status === "needsConfirm") {
          toast(r.reason, "info", 12000, () => void run(d, true), "确认发送");
          return false;
        }
        if (r.status === "budgetExceeded") {
          toast(budgetExceededMessage(r.spentCny, r.budgetCny), "info", 6000);
          return false;
        }
        toast("AI 没写成，请重试", "info");
        return false;
      } catch (e) {
        logger.warn("蒸馏成文失败", e);
        toast("AI 没写成，请重试", "info");
        return false;
      } finally {
        setAiBusy(null);
      }
    },
    [toast],
  );

  /**
   * 一键全部成文。这个按钮会花你 N 次钱，所以带三道闸：
   *
   * ① **串行**——并发等于同时向 provider 开 N 条连接，
   *    也让「撞到闸就停」变得不可能（钱已经花出去了）；
   * ② **任一篇不顺就停**——出网闸拦下 / 超预算 / 报错，均不再往下跑；
   * ③ **跳过已成文的**——重复点不会把同一篇再买一遍。
   */
  const aiAll = useCallback(async () => {
    const list = drafts.filter((d) => !aiDone.has(d.key));
    if (list.length === 0) return;
    setBatch({ done: 0, total: list.length });
    try {
      for (const [i, d] of list.entries()) {
        const ok = await runAi(d);
        setBatch({ done: i + 1, total: list.length });
        if (!ok) break;
      }
    } finally {
      setBatch(null);
    }
  }, [drafts, aiDone, runAi]);

  const undo = useCallback(async () => {
    if (!lastAction) return;
    const set = loadDismissed(today);
    lastAction.drafts.forEach((d) => set.delete(d.key));
    saveDismissed(today, set);
    if (lastAction.kind === "adopt") {
      for (const id of lastAction.noteIds) await noteDelete(id);
    }
    setLastAction(null);
    void reload();
  }, [lastAction, today, reload]);

  // 没草稿就整个不渲染。一个写着「今天没有可蒸馏的」的空区比没有更差。
  if (drafts.length === 0 && !lastAction) return null;

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.distillHead}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <Sparkles size={13} className={styles.distillIcon} />
        <span className={styles.bannerText}>
          可合成笔记 <b>{drafts.length}</b> 篇
          <span className={styles.bannerHint}>
            —— 今天同一个来源的碎片、以及这几天反复出现的，各合成一篇；存不存你说了算
          </span>
        </span>
        <ChevronDown
          size={13}
          className={`${styles.chevron}${expanded ? ` ${styles.chevronOpen}` : ""}`}
        />
      </button>

      {/* L4 首次说明：第一次真的有草稿时露一次，之后不再出现。
          摆在横幅下面、折叠态也在——它要回答的正是「我该不该展开」 */}
      {showFirstHint && (
        <div className={`${styles.firstHint} ${styles.firstHintDistill}`}>
          第一次出现 —— 这里每一篇都是把你复制过的几条内容合在一起拟的草稿。
          展开看看，存不存都由你；忽略了今天就不再提。
        </div>
      )}

      {lastAction && (
        <div
          className={styles.undoBar}
          onMouseEnter={() => setUndoHover(true)}
          onMouseLeave={() => setUndoHover(false)}
        >
          <span className={styles.undoText}>
            {lastAction.kind === "adopt"
              ? `已存 ${lastAction.noteIds.length} 篇笔记`
              : lastAction.drafts.length === 1
                ? `已忽略「${lastAction.drafts[0].title}」`
                : `已忽略 ${lastAction.drafts.length} 篇`}
          </span>
          <button type="button" className={styles.undoBtn} onClick={() => void undo()}>
            <Undo2 size={11} /> 撤销
          </button>
          <button
            type="button"
            className={styles.undoClose}
            onClick={() => setLastAction(null)}
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      )}

      {expanded && (
        <>
          <div className={styles.distillList}>
            {drafts.map((d) => (
              <div key={d.key} className={styles.distillCard}>
                <div className={styles.cardHead}>
                  <span className={`${styles.badge} ${styles.badgeDistill}`}>
                    <Sparkles size={9} />
                    {d.count} 条
                  </span>
                  {/* 只摆标题：P1 已带来源、P2 已带跨度，
                      再接一个 typeLabel 会变成「… · 跨 4 天 · 跨天主题」 */}
                  <span className={styles.cardTitle}>{d.title}</span>
                  {/* 花过钱的那几篇要标出来，否则重复点不知道哪篇已经买过 */}
                  {aiDone.has(d.key) && <span className={styles.aiTag}>AI 已成文</span>}
                </div>
                {/* 真实摘录，不是恒定文案——不露内容的话下面三个按钮全是盲点 */}
                <div className={styles.cardPreview} title={d.preview}>
                  {d.preview}
                </div>
                <div className={styles.cardActions}>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    // 只预填弹窗，**不落库**。不传 historyId：这篇是 N 条聚的，
                    // 挂到其中任何一条上都是假的归属。
                    onClick={() => openNote({ title: d.title, content: d.content })}
                  >
                    存为笔记
                  </button>
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    disabled={aiBusy !== null}
                    onClick={() => void runAi(d)}
                    // 已成文的那篇要说清再点会**再花一次**：它仍然可点（重写是
                    // 正当需求），但文案不变的话用户不知道自己又买了一次。
                    title={
                      aiDone.has(d.key)
                        ? "再发一次给 AI 重写——会再花一次调用"
                        : "把这一簇摘录发给你自己配的 AI，写成一篇草稿；不点就不发"
                    }
                  >
                    <Wand2 size={11} />{" "}
                    {aiBusy === d.key
                      ? "写作中…"
                      : aiDone.has(d.key)
                        ? "重写一次"
                        : "AI 写成一篇"}
                  </button>
                  <button type="button" className={styles.ghostBtn} onClick={() => dismissMany([d])}>
                    忽略
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* 批量条。

              🔴 它必须在**列表之后**、且只在展开时出现。
              初版把它常驻在横幅下面（理由是「折叠也能一键」），
              那是错的：折叠时一张卡片都看不见，「全部采纳 3 篇」里的
              那 3 篇是哪 3 篇无从得知——**盲点 + 批量落库**是最糟的组合，
              而「不露内容就逼着你做决定」正是卡片化那一轮要修的毛病。

              开头的「以上 N 篇」不是装饰：它把按钮与它们操作的东西绑在一起。*/}
          {drafts.length > 0 && (
            <div className={styles.batchBar}>
              <span className={styles.batchLabel}>以上 {drafts.length} 篇</span>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={adopt !== null || batch !== null || aiBusy !== null}
                onClick={() => void adoptAll()}
                title="把这几篇原样存成笔记，不开弹窗；存错了 6 秒内可撤销"
              >
                {adopt ? `存入中 ${adopt.done}/${adopt.total}` : "全部存为笔记"}
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                disabled={adopt !== null || batch !== null || aiBusy !== null}
                onClick={() => void aiAll()}
                title="逐篇发给你自己配的 AI 重写。串行跑，任一篇撞到出网闸或超预算就停"
              >
                <Wand2 size={11} />{" "}
                {batch ? `AI 写作中 ${batch.done}/${batch.total}` : "全部用 AI 写"}
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                disabled={adopt !== null || batch !== null || aiBusy !== null}
                onClick={() => dismissMany(drafts)}
              >
                全部忽略
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
