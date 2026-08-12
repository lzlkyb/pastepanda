/**
 * AiQuickBar.tsx —— 主窗口 AI 感知：复制后列表上方的 AI 快捷动作区。
 *
 * 交互：
 * - 内容变化 → 按内容特征给出 2-3 个动作 + 「更多…」→ 变换面板；
 * - 点动作直接运行：AI 思考中 → 结果展开（预览 + 复制/粘贴）；本地动作零成本即时；
 * - 敏感内容 → 确认条（确认后 force 重跑）；出错一律给「去设置 AI / 去调整预算」出口；
 * - ✕ 关闭当前内容的快捷区（换内容重新出现）。
 *
 * 本文件只管**栏本体与目标推导**（规则 #7，原本 666 行），其余已拆出：
 * - `hooks/useAiQuickRun`：执行编排（states / 代际守卫 / run / followup / copy / paste）
 * - `ai/AiQuickActions`：动作按钮组 + 拖拽排序
 * - `ai/AiQuickResult`：单个动作的结果卡四态
 * - `ai/quickTypes`：共享类型
 *
 * 门控（规则 15）：AI 不可用（未启用 / 没配密钥）时，需要 AI 的动作在
 * matchQuickActions 里就过滤掉了——结果只剩本地动作或整条不渲染，绝不摆一排
 * 点下去只会报错的按钮。App 那边的渲染条件只决定「用快捷区还是原建议条」，
 * 不代表 AI 一定可用，所以可用性必须在这里自己再判一次。
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, X } from "lucide-react";
import { AiMark } from "@/components/ai/AiMark";
import SourceBadge from "@/components/SourceBadge";
import { AiQuickActions } from "@/components/ai/AiQuickActions";
import { AiQuickResult } from "@/components/ai/AiQuickResult";
import { useAppStore } from "@/stores/appStore";
import { useDialogStore } from "@/stores/dialogStore";
import { isAiAvailable, applicableTransforms } from "@/lib/transforms";
import { matchQuickActions } from "@/lib/aiQuick";
import { parseFilePaths } from "@/lib/utils";
import { contentTypeLabel } from "@/lib/actionLabels";
import { useToast } from "@/components/Toast";
import { useAiQuickRun } from "@/hooks/useAiQuickRun";
import styles from "./AiQuickBar.module.css";

export const AiQuickBar = memo(function AiQuickBar() {
  const { toast } = useToast();
  /**
   * AI 栏的目标条目：**跟随焦点，焦点为空时回落最新条**。
   *
   * 以前是硬绑 `s.history[0]`，用户用键盘 ↑↓ 或点卡片换了焦点，AI 栏照旧指着最新条。
   *
   * 两个坑：
   * - **搜索模式下 focusId 指向的条目不一定在 history 里**：getFilteredItems() 在搜索时
   *   返回 searchResults（后端全量结果，含尚未分页加载到内存的记录）。
   *   只查 history 会静默退回最新条，而用户明明选中了另一条——所以先查 searchResults。
   * - **不能为了查找而订阅整个 history 数组**：那样任何一条置顶/删除/标签变动
   *   都会重渲染本栏，而它里面挂着在飞的 AI 请求状态（见 useAiQuickRun 的代际守卫）。
   *   所以只订阅 focusId / history[0] / historyVersion，具体查找走 getState()。
   */
  const focusId = useAppStore((s) => s.focusId);
  const latestItem = useAppStore((s) => s.history[0]);
  const historyVersion = useAppStore((s) => s.historyVersion);
  const topItem = useMemo(() => {
    if (!focusId) return latestItem;
    const s = useAppStore.getState();
    return (
      s.searchResults?.find((i) => i.id === focusId) ??
      s.history.find((i) => i.id === focusId) ??
      latestItem
    );
    // historyVersion 参与依赖：它是历史变更的统一信号，没它的话
    // “焦点条目被删”这类变化不会触发重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, latestItem, historyVersion]);
  const key = topItem?.id ?? "";

  /**
   * 动作的**实际输入**与它的类型。
   *
   * 文本类直接用 item.text；图片/文件类的 item.text 是空的，以前到这里就
   * `if (!t) return []` → 整条 AI 栏不渲染。现在从 `content` 里的路径派生输入，
   * 类型强制成 `file_path`——那正是 path_name / path_fslash / path_bslash
   * 三个本地变换 detect 里 `forType(ctx, "file_path", 0.8)` 的判据。
   *
   * pathDerived 会把所有出网动作禁掉（见 matchQuickActions）：路径里带用户名、
   * 目录结构、项目名，不能因为“反正有个输入”就隐式发给模型。
   */
  const { text, inputType, pathDerived } = useMemo(() => {
    const t = (topItem?.text || "").trim();
    if (t) {
      return {
        text: t,
        inputType: topItem?.content_type || topItem?.type || "text",
        pathDerived: false,
      };
    }
    const paths = parseFilePaths(topItem?.content || "");
    if (paths.length === 0) return { text: "", inputType: "text", pathDerived: false };
    return { text: paths.join("\n"), inputType: "file_path", pathDerived: true };
  }, [topItem?.text, topItem?.content, topItem?.content_type, topItem?.type]);

  /** 单行预览：换行先压成空格，否则多行文本在单行容器里只能看到第一行 */
  const tgtPreview = useMemo(() => {
    const t = (topItem?.text || "").replace(/\s+/g, " ").trim();
    if (t) return t;
    // 图片/文件条目没正文，以前这里直接显示“（空）”。改显示**文件名**而不是完整路径：
    // 摘要行只有一行，长路径会把真正有用的尾部挤出省略号外。
    const paths = parseFilePaths(topItem?.content || "");
    if (paths.length > 0) {
      const names = paths.map((p) => p.split(/[/\\]/).pop() || p);
      return names.length > 1 ? `${names[0]} 等 ${names.length} 个文件` : names[0];
    }
    return "（空）";
  }, [topItem?.text, topItem?.content]);

  /**
   * 目标是否**不在当前列表**。不说清这一态，用户会以为 AI 栏在处理
   * 搜索结果里的第一条。只在有筛选/搜索时才可能为真（无筛选时列表就是 history）。
   */
  const tgtOffList = useMemo(() => {
    if (!topItem) return false;
    return !useAppStore.getState().getFilteredItems().some((i) => i.id === topItem.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topItem?.id, historyVersion]);

  /**
   * AI 是否可用：用与变换面板同一个判据 isAiAvailable()，保证「快捷区推的动作」与
   * 「更多… 面板里能选的动作」不会一边有一边没。它是模块级缓存的同步值
   * （设置改完会调 refreshAiAvailability），每次渲染现读即可。
   */
  const aiOk = isAiAvailable();

  /**
   * 匹配动作：**打分全交给变换中心**的 applicableTransforms（规则 #11）。
   *
   * 以前是 aiQuick 自己一条 if/else 链，与变换中心的 scoreAiAction 并行且残缺：
   * content_type 共 18 种它只判 link、后端 16 个 AI 动作它只硬写 5 个，
   * 于是代码会被推“翻译”（代码里拉丁 token 占比必然过线）。
   * 现在 code/json/config 走 scoreAiAction 的 isCodeish，推的是解释代码/修错/commit。
   */
  const actions = useMemo(() => {
    if (!topItem || !text) return [];
    const candidates = applicableTransforms({
      text,
      contentType: inputType,
      // 标签参与打分：自动标签里的语言级（Rust/Java/SQL…）是 content_type 给不了的粒度；
      // 手工标签是用户意图，能把 ai-reply-draft / ai-weekly-report 这类
      // “文本里判不出来”的动作浮上来（见 tagBoost）。
      tags: topItem.tags?.map((t) => ({ name: t.name, source: t.source })),
      // html 只能给 doc/rich（它们的 content 是 CF_HTML 片段）。
      // file/image 的 content 是路径，当 html 交下去会让文档类变换误匹配。
      html: topItem.type === "rich" || topItem.type === "doc" ? topItem.content : undefined,
    }).map((s) => ({
      id: s.transform.id,
      label: s.transform.label,
      group: s.transform.group,
      remote: s.transform.remote,
    }));
    return matchQuickActions({ text, aiOk, candidates, pathDerived });
    // topItem?.tags 参与依赖：用户当场打上“待回复”这类标签后，建议应该立即重算。
    // disable 必须紧贴依赖数组上一行：中间夹一行注释它就落到注释上、对不到目标了。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topItem?.id, topItem?.type, topItem?.content, topItem?.tags, text, inputType, pathDerived, aiOk]);

  const [closed, setClosed] = useState(false);
  // 新内容 → 快捷区重新出现。
  // useAiQuickRun 里有一个**同依赖**的 effect 负责清结果并推进代际，
  // 两边各自拥有自己的状态，但触发条件必须一致。
  useEffect(() => {
    setClosed(false);
  }, [topItem?.id, topItem?.text]);

  const run = useAiQuickRun({ item: topItem, text, toast });

  /** 更多 → 打开变换面板并定位 */
  const openMore = useCallback(() => {
    if (!topItem) return;
    useDialogStore.getState().openHub(topItem, text);
  }, [topItem, text]);

  if (!topItem || actions.length === 0 || closed) return null;

  return (
    <AnimatePresence>
      <motion.div
        key={key}
        className={styles.wrap}
        initial={{ opacity: 0, y: -8, height: 0 }}
        animate={{ opacity: 1, y: 0, height: "auto" }}
        exit={{ opacity: 0, y: -8, height: 0 }}
        transition={{ duration: 0.18 }}
      >
        <div className={styles.bar}>
          {/* 栏内标题的 AI 标识：这里曾经是硬写的 <Sparkles/> AI，跟其它五处各长各样。
              用 label 形态（无底无边）是因为 .bar 本身已经有底色与描边，再套一层只会变脏。 */}
          <AiMark shape="label" icon={<Sparkles size={11} />} text="AI" />

          <AiQuickActions
            actions={actions}
            states={run.states}
            onRun={(a) => void run.runAction(a)}
            onMore={openMore}
          />

          <span className={styles.hintTxt}>
            {/* 走共享映射（规则 #11）。原来是手写三元：只认 link 与 text，
                其余全部兜底到 `topItem.type` → 图文直接显示内部 id「rich」。 */}
            {contentTypeLabel(topItem.content_type || topItem.type)}
          </span>
          <button className={styles.x} onClick={() => setClosed(true)} title="关闭">
            <X size={12} />
          </button>

          {/* 目标摘要行：告诉用户“现在处理的是哪条”。

              为什么必需：AI 栏在列表上方、与卡片分离；焦点为空时回落到最新条，
              而那条在有筛选/搜索时可能根本不在列表里。卡片侧不加任何高亮（用户要求），
              所以这一行是用户判断目标的唯一依据。

              **必须放在 .bar 的最末**：它带 width:100%，靠 .bar 的 flex-wrap 自然落到第二行。
              放到中间的话会把后面的动作组/类型标签/关闭按钮全挤到第三行，
              并且把 .hintTxt 的 margin-left:auto（负责把类型+关闭推到右端）的推挤关系打断。 */}
          <div className={styles.tgt}>
            {/* 来源标签与卡片完全同款：同一个 SourceBadge、同一档 size="small"
                （参 Card.tsx）。不再自己拼图标+名称，图标双模式也由它内部处理。
                原来那个 · 分隔符去掉：胶囊自带底色与描边，已经是视觉分隔，卡片那边也没有。
                noHover 是唯一差别：卡片可点，这一行不可点。 */}
            {topItem.source && (
              <SourceBadge source={topItem.source} sourceIcon={topItem.source_icon} size="small" noHover />
            )}
            <span className={styles.tgtTxt}>{tgtPreview}</span>
            {tgtOffList && (
              <span className={styles.tgtOff} title="当前筛选/搜索下看不到这条，但 AI 动作仍作用于它">
                不在当前列表
              </span>
            )}
          </div>
        </div>

        {/* 结果 / 确认 / 错误区（注意用 actions 而不是排序后的：结果卡的顺序跟动作按钮无关） */}
        {actions.map((a) => {
          const st = run.states[a.id];
          if (!st || st.status === "idle") return null;
          return <AiQuickResult key={a.id} action={a} state={st} text={text} run={run} />;
        })}
      </motion.div>
    </AnimatePresence>
  );
});
