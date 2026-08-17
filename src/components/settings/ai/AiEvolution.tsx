/**
 * AI 设置页的「自进化」区（方案 B，2026-08-11）。
 *
 * 搬家背景：以前入口在「设置 › 通用」的一行🧠，点一下才开 LearningsDialog（427 行）。
 * 现在入口与高频操作（看画像、清空某一类）直接摆在 AI 页，
 * **明细列表仍然留在那个宽弹窗里**——427 行内容硬塞进 380px 宽的面板只会变难用。
 *
 * 两条不能破的红线：
 * ① 学习只影响排序、永不自动执行 → 文案里“会排在更靠前”这句保留；
 * ② 使用日志永不出本机、且用户可见可删 → 声明条常驻，清空入口不能变难找。
 *
 * 自己包 AiSection（而不是由 AiTab 包）：副标题要用到拉回来的计数，
 * 而 AiSection 折叠时不渲染 children——被父级包就拿不到数据。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, ShieldCheck, Trash2, UserRound, ChevronRight, Loader2 } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { confirmDialog } from "@/lib/confirm";
import { useToast } from "@/components/Toast";
import {
  actionEventStats,
  actionDismissals,
  actionLearningsClear,
} from "@/lib/api/actionEvents";
import { aiFeedbackStats, aiFeedbackClear, actionPrefsAll } from "@/lib/api/aiFeedback";
import { historySummariesCount, historySummariesClear } from "@/lib/api/contentMemory";
import { AiSection } from "./AiSection";
import { AiProfileInject } from "./AiProfileInject";
import styles from "../AiTab.module.css";

interface Summary {
  /** 近 30 天动作使用总次数 */
  total: number;
  /** 已停用推荐条数 */
  dismissed: number;
  /** AI 结果编辑率（0~100，按总量加权）；null = 还没有足够样本 */
  editRate: number | null;
  /** 有反馈统计的动作数 */
  fbActions: number;
  /** 已设偏好指令的动作数 */
  prefs: number;
  /** 内容记忆（历史摘要）条数 */
  memory: number;
}

interface Props {
  open: boolean;
  onToggle: () => void;
  /** D1：画像是否拼进 AI 的 system prompt（`AiConfig.profileAsContext`） */
  profileAsContext: boolean;
  onProfileAsContextChange: (v: boolean) => void;
}

export function AiEvolution({ open, onToggle, profileAsContext, onProfileAsContextChange }: Props) {
  const { toast } = useToast();
  const [sum, setSum] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  // 一次性加载保护：本组件常驻挂载，加载失败后不再自动重试，
  // 避免 effect 因 sum 仍为空而无限重入 + 反复弹 error toast（P1）。
  const attemptedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, d, fb, p, mem] = await Promise.all([
        actionEventStats(30),
        actionDismissals(),
        aiFeedbackStats(30),
        actionPrefsAll(),
        historySummariesCount(),
      ]);
      // 编辑率按**总量加权**而不是算各动作平均：
      // 后者会让一个只用过 5 次的动作和用过 500 次的同等拉扯均值。
      // 与弹窗一致：只统计 total >= 5 的动作（样本太少的编辑率没有意义）。
      const valid = fb.filter((x) => x.total >= 5);
      const totalFb = valid.reduce((n, x) => n + x.total, 0);
      const totalEdited = valid.reduce((n, x) => n + x.edited, 0);
      setSum({
        total: s.total,
        dismissed: d.length,
        editRate: totalFb > 0 ? Math.round((totalEdited / totalFb) * 100) : null,
        fbActions: valid.length,
        prefs: p.length,
        memory: mem,
      });
    } catch (e) {
      toast(`读取学习记录失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // 只在展开时拉一次：本组件常驻挂载（包着 AiSection），attemptedRef 保证无论
  // 成功失败都只发一次，失败后不会因 sum 仍为空而无限重入（P1 修复）。
  useEffect(() => {
    if (open && !attemptedRef.current) {
      attemptedRef.current = true;
      void load();
    }
  }, [open, load]);

  /** 带二次确认的清空（红线②：可删，但删了就没了，得问一声） */
  const clearWith = useCallback(
    async (opts: { title: string; message: string; run: () => Promise<unknown>; ok: string }) => {
      const yes = await confirmDialog({
        title: opts.title,
        message: opts.message,
        confirmText: "清空",
      });
      if (!yes) return;
      try {
        await opts.run();
        toast(opts.ok, "success");
        setSum(null); // 下一个 effect 会重拉，不自己猜新值
      } catch (e) {
        toast(`清空失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [toast]
  );

  const openLearnings = () => useDialogStore.getState().openLearnings();

  const subtitle = sum
    ? `近 30 天 ${sum.total} 次 · 仅存本机`
    : "仅存本机 · 可随时查看或清空";

  return (
    <AiSection
      icon={<Brain size={13} />}
      title="自进化"
      subtitle={subtitle}
      open={open}
      onToggle={onToggle}
    >
      {/* 红线②声明：常驻，不可折叠 */}
      <div className={styles.redline}>
        <ShieldCheck size={13} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          学习数据<b>仅存本机</b>，不含任何复制内容本身，可随时查看或清空。
          它只影响推荐排序，<b>永不自动执行任何动作</b>。
        </span>
      </div>

      {loading && !sum ? (
        <div className={styles.usageNote}>
          <Loader2 size={12} className="spin" /> 加载中…
        </div>
      ) : (
        <>
          <div className={styles.evoStats}>
            <div className={styles.evoStat}>
              <div className={styles.evoNum}>{sum?.total ?? "—"}</div>
              <div className={styles.evoLabel}>30 天使用</div>
            </div>
            <div className={styles.evoStat}>
              <div className={styles.evoNum}>
                {sum?.editRate === null || sum === null ? "—" : <>{sum.editRate}<small>%</small></>}
              </div>
              <div className={styles.evoLabel}>AI 结果编辑率</div>
            </div>
            <div className={styles.evoStat}>
              <div className={styles.evoNum}>{sum?.dismissed ?? "—"}</div>
              <div className={styles.evoLabel}>已停用推荐</div>
            </div>
          </div>

          <button
            className={styles.evoRow}
            onClick={() => useDialogStore.getState().openProfile()}
          >
            <span className={styles.evoName}>
              <UserRound size={12} /> 我的画像
              <span className={styles.evoDesc}>基于使用统计，可用 AI 精炼成一段描述</span>
            </span>
            <ChevronRight size={13} className={styles.evoChev} />
          </button>

          {/* 紧跟在「我的画像」下面：上一行回答“画像是什么”，这一行回答“画像被拿去干什么”。 */}
          <AiProfileInject enabled={profileAsContext} onChange={onProfileAsContextChange} />

          {/* 注意：这个清空只清**反馈统计**，不动偏好指令——与弹窗里的文案一致。
              两者写成两行而不合并，就是为了不让人以为清反馈会把偏好指令一起删了。 */}
          <div className={styles.evoRow}>
            <span className={styles.evoName}>
              AI 结果反馈
              <span className={styles.evoDesc}>
                {sum ? `${sum.fbActions} 个动作有统计` : "—"} · 只影响“哪些动作常被修改”
              </span>
            </span>
            <button
              className={`${styles.evoBtn} ${styles.evoBtnDanger}`}
              onClick={() =>
                void clearWith({
                  title: "清空 AI 反馈",
                  message: "清空 AI 结果反馈？只影响「哪些动作常被修改」的统计，不影响偏好指令。",
                  run: aiFeedbackClear,
                  ok: "已清空 AI 结果反馈",
                })
              }
            >
              <Trash2 size={11} /> 清空
            </button>
          </div>

          <button className={styles.evoRow} onClick={openLearnings}>
            <span className={styles.evoName}>
              输出偏好指令
              <span className={styles.evoDesc}>
                {sum ? `${sum.prefs} 个动作已设` : "—"} · 在这里编辑需要完整面板
              </span>
            </span>
            <ChevronRight size={13} className={styles.evoChev} />
          </button>

          <div className={styles.evoRow}>
            <span className={styles.evoName}>
              本地检索记忆
              <span className={styles.evoDesc}>{sum ? `${sum.memory} 条摘要` : "—"} · 用于语义搜索</span>
            </span>
            <button
              className={`${styles.evoBtn} ${styles.evoBtnDanger}`}
              onClick={() =>
                void clearWith({
                  title: "清空内容记忆",
                  message: "清空后语义搜索会失去已有摘要，而且不会自动补回存量（删了就是删了），确定吗？",
                  run: historySummariesClear,
                  ok: "已清空内容记忆",
                })
              }
            >
              <Trash2 size={11} /> 清空
            </button>
          </div>

          {/* 虚线：这一项管的是变换中心排序，**本地变换也在内**，严格说不属于 AI。
              搬进 AI 页是为了“自进化”概念不被拆散，但得把这件事写在脸上。 */}
          <button className={`${styles.evoRow} ${styles.evoRowDashed}`} onClick={openLearnings}>
            <span className={styles.evoName}>
              推荐偏好 · 已停用推荐
              <span className={styles.evoDesc}>管的是变换中心排序（含本地变换）· 可恢复</span>
            </span>
            <span className={styles.evoBtn}>看全部</span>
          </button>

          <div className={styles.evoRow}>
            <span className={styles.evoName}>
              清空全部学习记录
              <span className={styles.evoDesc}>排序退回「对所有人一样」的默认状态</span>
            </span>
            <button
              className={`${styles.evoBtn} ${styles.evoBtnDanger}`}
              onClick={() =>
                void clearWith({
                  title: "清空学习记录",
                  message: "清空后推荐排序会退回「对所有人一样」的状态，确定清空吗？",
                  run: actionLearningsClear,
                  ok: "已清空学习记录",
                })
              }
            >
              <Trash2 size={11} /> 清空
            </button>
          </div>
        </>
      )}
    </AiSection>
  );
}
