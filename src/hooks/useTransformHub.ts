import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getAiAvailability, subscribeAiAvailability } from "@/lib/aiAvailability";
import { useDialogStore } from "@/stores/dialogStore";
import { getTransform, type Transform, type TransformContext, type TransformResultMeta } from "@/lib/transforms";
import { isPinnedAction, recommendScored, sceneOf } from "@/lib/recommend";
import { manualTagsOpt } from "@/lib/aiTags";
import { ocrImage, pasteTextGuarded } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import type { NlParseResult } from "@/lib/nlActionParser";
import { specsFor, defaultOptsFromSpecs } from "@/components/transform/transformOptions";
import { useActionEventLog } from "@/hooks/useActionEventLog";
import { useDialogEscape } from "@/hooks/useDialogEscape";

export function useTransformHub() {
  const aiStatus = useSyncExternalStore(subscribeAiAvailability, getAiAvailability, getAiAvailability);
  const aiAvailable = aiStatus.status === "on";
  const item = useDialogStore((s) => s.hubItem);
  // 图片预览里框选一块后传进来的文字；有它就不再自己 OCR
  const override = useDialogStore((s) => s.hubText);
  const open = !!item;
  const chainOpen = useDialogStore(s => s.chainText !== null);
  const chainEditing = useDialogStore(s => s.chainEdit !== null);
  const suspended = chainOpen || chainEditing;
  const { toast } = useToast();

  // 每个变换各自维护选项（id → {key: value}），互不影响
  const [opts, setOpts] = useState<Record<string, Record<string, string>>>({});
  // 刚完成复制的卡片（仅用于按钮"已复制"反馈，与选中无关）
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Tier1 编解码工作台开关（从枢纽打开独立工具弹窗）
  const [showCodec, setShowCodec] = useState(false);
  // Tier2 二维码双向工作台开关（生成 + 识图解码）
  const [showQr, setShowQr] = useState(false);
  const [manualId, setManualId] = useState<string | null>(null);
  useEffect(() => { setManualId(null); }, [item?.id]);

  const close = useCallback(() => {
    setShowCodec(false);
    setShowQr(false);
    useDialogStore.getState().closeHub();
  }, []);

  // ===== 图片：先本地 OCR，再把识别出的文字交给整套变换 =====
  //
  // 这样不用为图片另造一套动作：翻译/解释报错/提取要点那些现成的东西直接就能用。
  // OCR 是本地引擎，**不受 AI 总开关影响**——关掉 AI 也能识别，只是下面没云端动作可选。
  const isImage = item?.type === "image";
  const [ocrText, setOcrText] = useState("");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState("");

  const runOcr = useCallback(async () => {
    const path = item?.content;
    if (!path) return;
    setOcrLoading(true);
    setOcrError("");
    try {
      const r = await ocrImage(path);
      const text = r.fullText.trim();
      setOcrText(text);
      if (!text) {
        setOcrError("这张图里没识别出文字。手写、艺术字、分辨率太低都会这样。");
      }
    } catch (e) {
      setOcrError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcrLoading(false);
    }
  }, [item?.content]);

  // 换条目时重置；图片且没有覆盖文本时自动识别一次
  useEffect(() => {
    setOcrText("");
    setOcrError("");
    if (open && isImage && !override) void runOcr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, open, isImage, override]);

  /** 真正拿去做变换的文本：框选覆盖 > 图片 OCR > 条目自带的文本 */
  const sourceText = override ?? (isImage ? ocrText : item?.text || "");

  // 变换上下文（动态选项解析的输入，如 SQL IN 的可选字段来自对象数组实际字段）
  const ctx = useMemo<TransformContext>(
    () => ({
      text: sourceText,
      // 图片 OCR 出来的就是普通文本，不能再拿 image 当类型（否则没一个变换会命中）
      contentType: isImage ? "text" : item ? item.content_type || item.type : "",
      // 标签参与打分：自动标签里的语言级（Rust/Java/SQL…）是 content_type 给不了的粒度；
      // 手工标签能把 ai-reply-draft / ai-weekly-report 这类靠意图的动作浮上来（见 tagBoost）。
      tags: item?.tags?.map((t) => ({ name: t.name, source: t.source })),
      // P2 文档管线：doc/rich 条目把 CF_HTML 片段透传给文档类变换
      html: item && (item.type === "doc" || item.type === "rich") ? item.content : undefined,
    }),
    [item, sourceText, isImage],
  );

  // 当前内容命中的变换（v6.1：个性化排序 = 静态分 × 个人使用频次，含负反馈剔除），过滤 < 0.3 的噪声
  // learnRev 是负反馈后的刷新信号：点了「不再推荐」就 +1 触发重算
  const [learnRev, setLearnRev] = useState(0);
  const scored = useMemo(
    () =>
      item
        ? recommendScored(ctx, sceneOf(new Date().getHours(), item.source)).filter(
            // 置顶的动作**无条件绕过 0.3 门槛**。
            //
            // 不这么做会出一个必然 bug：现在五因子里四个因无行为数据而恒为 1，
            // score 就等于基础分，而基础分算的是“能不能处理这类内容”——
            // 很多真正常用的工具分数并不高。用户置顶了却看不到它，比不做还糟。
            (s) => s.score >= 0.3 || isPinnedAction(s.transform.id),
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item, ctx, learnRev, aiAvailable],
  );

  /**
   * 负反馈：「不再推荐这个」。
   * 记录到本地后刷新推荐状态 + 本组件重算排序（该卡片随即消失）。
   */
  const handleDismiss = useCallback(
    async (actionId: string) => {
      try {
        const { actionDismissAdd } = await import("@/lib/api/actionEvents");
        await actionDismissAdd(actionId, ctx.contentType);
        const { refreshRecommendState } = await import("@/lib/recommend");
        await refreshRecommendState();
        setLearnRev((v) => v + 1);
        toast(`不再推荐「${actionId}」`, "success");
      } catch (e) {
        toast(`操作失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [ctx.contentType, toast],
  );

  /**
   * 正向偏好：置顶 / 取消置顶。走与 `handleDismiss` 同一条刷新路径。
   *
   * 后端的 `action_pin_add` 会顺手清掉该动作的 dismiss，所以这里不用再调一次。
   */
  const handleTogglePin = useCallback(
    async (actionId: string, next: boolean) => {
      try {
        const { actionPinAdd, actionPinRemove } = await import("@/lib/api/actionEvents");
        // 全局置顶：contentType 传空串
        if (next) await actionPinAdd(actionId, "");
        else await actionPinRemove(actionId, "");
        const { refreshRecommendState } = await import("@/lib/recommend");
        await refreshRecommendState();
        setLearnRev((v) => v + 1);
        toast(next ? "已设为常用，以后排在最前" : "已取消常用", "success");
      } catch (e) {
        toast(`操作失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [toast],
  );

  // 分区：常用（置顶）→ 推荐（≥0.6）→ 其他工具（<0.6）
  //
  // 置顶是**分组前置**而不是再乘一个因子：乘因子会被其它因子稀释，做不到“恒排最前”。
  // 组内部仍沿用 recommendScored 的原有排序（filter 天然保持顺序），不再发明一套置顶内部序。
  const pinned = useMemo(() => scored.filter((s) => isPinnedAction(s.transform.id)), [scored]);
  const recommended = useMemo(
    () => scored.filter((s) => !isPinnedAction(s.transform.id) && s.score >= 0.6),
    [scored],
  );
  const others = useMemo(
    () => scored.filter((s) => !isPinnedAction(s.transform.id) && s.score < 0.6),
    [scored],
  );

  // P2：doc/rich 条目的 HTML 片段，注入到变换的 opts 供 run() 取用
  const itemHtml = item && (item.type === "doc" || item.type === "rich") ? item.content : undefined;
  /** 手工标签名，与 itemHtml 同一条路透传给 TransformCard → 后端的 ai_tags_as_context */
  const itemUserTags = manualTagsOpt(item?.tags);

  // 打开 / 切换内容时重置选项与复制反馈
  useEffect(() => {
    const init: Record<string, Record<string, string>> = {};
    for (const { transform: t } of scored) init[t.id] = defaultOptsFromSpecs(specsFor(t, ctx));
    setOpts(init);
    setCopiedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const optsFor = useCallback(
    (t: Transform) => opts[t.id] ?? defaultOptsFromSpecs(specsFor(t, ctx)),
    [opts, ctx],
  );
  const setOpt = useCallback(
    (id: string, key: string, value: string) =>
      setOpts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [key]: value } })),
    [],
  );

  /**
   * 记一笔动作事件（v6.0 action_events 表）。
   *
   * fire-and-forget：写不进去也只是少一条统计，绝不能拖慢复制/粘贴本身。
   * 只记「动作 + 内容类型 + 来源应用 + 时段 + 结果」，不含任何内容文本。
   */
  const logEvent = useActionEventLog(ctx.contentType, item?.source, item?.id);

  /**
   * 复制卡片**已经算好的**产物。
   *
   * 不在这里重跑 `t.run()`：本地变换重跑是白费一次计算，
   * 云端动作重跑则是多一次网络往返。
   */
  const copyOutput = useCallback(
    async (t: Transform, output: string, meta?: TransformResultMeta) => {
      try {
        await navigator.clipboard.writeText(output);
        // 复制成功 = 用户认可这个动作的产物，记一笔（fire-and-forget）
        logEvent(t, "copied");
        const n = meta?.count;
        toast(n ? `已复制「${t.label}」（${n} 个值）` : `已复制「${t.label}」`, "success");
        setCopiedId(t.id);
        setTimeout(() => setCopiedId((cur) => (cur === t.id ? null : cur)), 1200);
      } catch {
        toast("复制失败", "error");
      }
    },
    [toast, logEvent],
  );

  /** 把卡片已算好的产物直接粘贴到前台窗口 */
  const pasteOutput = useCallback(
    async (t: Transform, output: string) => {
      const ok = await pasteTextGuarded(output);
      if (ok) {
        toast(`已粘贴「${t.label}」`, "success");
        // 粘贴成功 = 内容真正被用上，这是最有价值的「有价值」信号
        logEvent(t, "pasted");
      }
    },
    [toast, logEvent],
  );

  // Esc 关闭（其余导航键交由卡片按钮 / Tab 处理）。
  //
  // ❗ 编解码 / 二维码工作台打开时不接 Esc：它们自己也在 window 上监听 Escape，
  //   `preventDefault` 不会阻止同级 listener，两边都跑会把工作台和枢纽一起关掉。
  //   （这段旧注释描述的正是 2026-09-06 统一治的那个毛病；这里先保留原有回避，
  //   因为工作台那边还没换成 `useDialogEscape`，换完即可去掉这两个条件。）
  useDialogEscape(close, open && !suspended && !showCodec && !showQr);

  // v6.3 自然语言动作定位：命中动作卡片滚动到可视区 + 短暂高亮
  const [activeActionId, setActiveActionId] = useState<string | null>(null);

  const actionRefs = useRef(new Map<string, HTMLDivElement>());
  const activeTimerRef = useRef<number | null>(null);
  // 审查：卸载时清理定位高亮 timer（避免卸载后 setState）
  useEffect(() => {
    return () => {
      if (activeTimerRef.current !== null) window.clearTimeout(activeTimerRef.current);
    };
  }, []);

  // 显式选中的动作不受自动推荐阈值限制，运行仍由卡片自己控制。
  const selectTransform = useCallback((id: string) => {
    const t = getTransform(id);
    if (!t || (t.remote && !isAiAvailable())) return;
    // 已展示的卡片只定位，不移组重挂载，保留其运行结果与追问状态。
    setManualId(scored.some(s => s.transform.id === id) ? null : id);
    actionRefs.current.get(id)?.scrollIntoView?.({ block: "nearest" });
    setActiveActionId(id);
    if (activeTimerRef.current !== null) window.clearTimeout(activeTimerRef.current);
    activeTimerRef.current = window.setTimeout(() => setActiveActionId(null), 1800);
  }, [scored]);
  // 等手动卡片挂载后再定位，避免对不存在的卡片报“已定位”。
  useEffect(() => {
    if (activeActionId) actionRefs.current.get(activeActionId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeActionId, manualId]);
  const handleNlApply = useCallback((r: NlParseResult) => {
    if (r.workbench === "qr") { setShowQr(true); return; }
    if (r.workbench === "codec") { setShowCodec(true); return; }
    if (r.aiDisabled) { toast("AI 未启用，请先到设置里启用并配置服务商", "info"); return; }
    if (!r.actionId || !getTransform(r.actionId)) {
      toast("没找到这个操作，请在全部变换里查找", "info");
      return;
    }
    if (r.params) setOpts(prev => ({ ...prev, [r.actionId!]: { ...(prev[r.actionId!] ?? {}), ...r.params } }));
    selectTransform(r.actionId);
  }, [toast, selectTransform]);
  const selectedTransform = manualId ? getTransform(manualId) : undefined;
  const manual = selectedTransform && (!selectedTransform.remote || isAiAvailable())
    ? scored.find(s => s.transform.id === manualId) ?? { transform: selectedTransform, score: 0 }
    : undefined;
  return {
    item, override, open, suspended, aiAvailable, close, showCodec, setShowCodec, showQr, setShowQr,
    isImage, ocrText, setOcrText, ocrLoading, ocrError, runOcr, sourceText, ctx,
    scored, pinned, recommended, others, manual, selectTransform, optsFor, setOpt,
    itemHtml, itemUserTags, copiedId, copyOutput, pasteOutput, handleDismiss, handleTogglePin,
    actionRefs, activeActionId, handleNlApply, 
  };
}
