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
import { isPinnedAction } from "@/lib/recommend";
import { matchQuickActions } from "@/lib/aiQuick";
import { parseFilePaths } from "@/lib/utils";
import { ocrImage } from "@/lib/api/images";
import { contentTypeLabel } from "@/lib/actionLabels";
import { useToast } from "@/components/Toast";
import { useAiQuickRun } from "@/hooks/useAiQuickRun";
import styles from "./AiQuickBar.module.css";

/** 模块级 OCR 请求令牌：每次发起图片 OCR 自增，换条目即作废旧请求的结果。 */
let ocrToken = 0;

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

  /** 图片条目自动 OCR 暖启动：本地识别、不联网不存储，仅用于本次推荐。 */
  const [ocrText, setOcrText] = useState("");
  const [ocrLoading, setOcrLoading] = useState(false);

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
    // 图片条目：item.text 是 "[图片] WxH" 占位（非真实内容），一律走本地 OCR。
    // 不能像文本那样直接拿 item.text 当输入——否则永远命中占位文本、OCR 分支到不了。
    // 对齐 TransformHubDialog（sourceText = isImage ? ocrText : item.text）。
    if (topItem?.type === "image") {
      const ocr = ocrText.trim();
      if (ocr) {
        // 以文字内容推导类型：applicableTransforms 内部 analyzeContent 会从 OCR 文本
        // 特征重判 code/link/json 等（与 TransformHubDialog contentType:"text" 一致）
        return { text: ocr, inputType: "text", pathDerived: false };
      }
      // 方案 A：OCR 中或无文字都不再回落路径三件套（图片路径不是“文件路径”
      // 变换的合理输入，推反斜杠路径纯属误导）。无文字时由「未从图片识别到文字」
      // 显式空态承接，而非用本地路径变换假装“有功能”。
      return { text: "", inputType: "text", pathDerived: false };
    }
    // 非图片：原有逻辑（文本类直接用 item.text；文件类从路径派生）
    const t = (topItem?.text || "").trim();
    if (t) {
      return {
        text: t,
        inputType: topItem?.content_type || topItem?.type || "text",
        pathDerived: false,
      };
    }
    // 非图片文件：从路径派生（保持原行为）
    const paths = parseFilePaths(topItem?.content || "");
    if (paths.length === 0) return { text: "", inputType: "text", pathDerived: false };
    return { text: paths.join("\n"), inputType: "file_path", pathDerived: true };
  }, [topItem?.text, topItem?.content, topItem?.content_type, topItem?.type, ocrText, ocrLoading]);

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
    // v6.14 置顶前置。与变换中心保持一致：两个入口不能给出不同顺序。
    //
    // 放在 matchQuickActions **之前**：它只取前 3 个（max=3），而且完全保持输入顺序，
    // 所以前置必须在它之前发生，否则置顶的动作可能根本进不了那 3 个名额。
    //
    // 用稳定排序：组内仍沿用 applicableTransforms 的静态分顺序，只把置顶的整体抬到前面。
    //
    // 注意一个**固有限制**（不绕）：matchQuickActions 只收 AI 组与 NON_AI_ALLOW 白名单，
    // 所以置顶一个普通本地变换（如“去除空行”）在这里仍不会出现——
    // 那是 AiQuickBar 作为“AI 快捷条”的定位使然，不应该为了置顶去改它。
    // 置顶在变换中心是无条件生效的。
    const ordered = [...candidates].sort(
      (a, b) => Number(isPinnedAction(b.id)) - Number(isPinnedAction(a.id)),
    );
    return matchQuickActions({ text, aiOk, candidates: ordered, pathDerived });
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

  /**
   * 图片条目：自动本地 OCR 暖启动（对齐 TransformHubDialog 范式，方案 A）。
   *
   * 只要 type==="image" 且有 content（图片路径）就跑本地 OCR；图片的 item.text
   * 是 "[图片] WxH" 占位、永远非空，不能用 !text 判断要不要 OCR。
   * 以 OCR 文本作为 AI 栏输入，而非把图片当文件路径去推 path_name/path_fslash/path_bslash。
   *
   * 代际守卫：焦点切走（topItem.id 变）即作废，避免旧 OCR 回填上一条图片。
   * 完全本地、不受 AI 开关影响，符合隐私红线（不联网、不存储、仅本次推荐）。
   */
  useEffect(() => {
    if (topItem?.type === "image" && topItem.content) {
      // 请求令牌：换条目（topItem 变）即自增，确保只有“当前焦点图”的结果会被应用。
      // 修复 StrictMode 双调用竞态：第一次（试探）调用的好结果不再被 cancelled 丢掉，
      // 也不会被第二次并发调用的空结果覆盖；只采用最新焦点图的最佳（非空）结果。
      const myToken = ++ocrToken;
      setOcrLoading(true);
      setOcrText("");
      const runOcr = async () => {
        // 串行重试最多 2 次：OCR 偶发瞬时返回空（并发/文件尚未落盘），重试即可拿到真实文字。
        // 串行而非并发，避免自己制造竞态。
        for (let attempt = 0; attempt < 2; attempt++) {
          if (myToken !== ocrToken) return; // 已切换到别的条目，作废本次
          try {
            const res = await ocrImage(topItem.content);
            if (myToken !== ocrToken) return;
            const txt = (res?.fullText || "").trim();
            if (txt) {
              setOcrText(txt);
              setOcrLoading(false);
              return;
            }
          } catch {
            if (myToken !== ocrToken) return;
          }
          // 空结果/失败：等 400ms 再试一次（仅 1 次重试）
          if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
        }
        if (myToken !== ocrToken) return;
        setOcrText("");
        setOcrLoading(false);
      };
      void runOcr();
      return () => { ocrToken++; }; // 本 effect 卸载 → 作废自己发起的请求
    }
    // 非图片：无需 OCR
    setOcrText("");
    setOcrLoading(false);
  }, [topItem?.id, topItem?.type, topItem?.content]);

  const run = useAiQuickRun({ item: topItem, text, toast });

  /** 更多 → 打开变换面板并定位 */
  const openMore = useCallback(() => {
    if (!topItem) return;
    useDialogStore.getState().openHub(topItem, text);
  }, [topItem, text]);

  // 图片正在本地 OCR（尚无文字）：单独承接占位态，不让整条消失，也不推路径三件套。
  const isImageOcrPending = !!topItem && topItem.type === "image" && ocrLoading && !ocrText.trim();
  // 图片 OCR 已完成、但没识别出文字：显式空态，不推路径三件套、也不整条消失。
  const isImageOcrEmpty = !!topItem && topItem.type === "image" && !ocrLoading && !ocrText.trim();
  // 图片 OCR 已识别到文字：主行空间紧张，有徽章时隐藏类型标签（徽章本身已表达
  // 「图片 + 已识别 N 字」），保证类型/徽章/动作全部在主行（方案 C）。
  const imageOcrHasText = !!topItem && topItem.type === "image" && !ocrLoading && !!ocrText.trim();

  if (!topItem || closed) return null;
  if (actions.length === 0 && !isImageOcrPending && !isImageOcrEmpty) return null;

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

          {isImageOcrPending ? (
            <span className={styles.ocrPending}>
              <span className={styles.ocrSpinner} />
              识别图片文字中…
            </span>
          ) : isImageOcrEmpty ? (
            <span className={styles.ocrBadgeMuted}>未从图片识别到文字</span>
          ) : (
            <AiQuickActions
              actions={actions}
              states={run.states}
              onRun={(a) => void run.runAction(a)}
              onMore={openMore}
            />
          )}

          <span className={styles.hintTxt}>
            {/* 走共享映射（规则 #11）。原来是手写三元：只认 link 与 text，
                其余全部兜底到 `topItem.type` → 图文直接显示内部 id「rich」。
                方案 C：图片 OCR 识别到文字时隐藏类型标签——徽章「N 字」已表达
                「图片 + 已识别 N 字」，再留类型标签只会把徽章挤出主行。 */}
            {!imageOcrHasText && contentTypeLabel(topItem.content_type || topItem.type)}
            {/* 图片 OCR 已识别到文字：徽章保留完整「已识别 N 字」文案
                （单写「N 字」用户不知道含义）；类型标签已隐藏，徽章本身
                已表达「图片 + 已识别 N 字」 */}
            {imageOcrHasText && (
              <span className={styles.ocrBadge}>已识别 {ocrText.trim().length} 字</span>
            )}
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
