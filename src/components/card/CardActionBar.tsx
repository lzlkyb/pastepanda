/**
 * components/card/CardActionBar.tsx —— 卡片动作条（v6.0 复制即执行）。
 *
 * 「复制即动作」与「复制后再找工具」的分界线：不用打开变换枢纽，
 * 悬停卡片就能看到当前内容适用的执行类动作（kind === "action"）并直接执行。
 *
 * 只显示执行类动作（打开链接/定位路径/发邮件/查 whois），不显示 text 类变换——
 * 后者需要预览与选项，枢纽更合适。最多 3 个，按匹配度取前几个，避免刷屏。
 *
 * 执行走变换自己的 run()（内部经后端 open_url 协议白名单 / open_file_location），
 * 失败原因原样 toast 回来，不留静默失败。
 */
import { memo, useMemo } from "react";
import { getTransform } from "@/lib/transforms";
import { recommendScored, sceneOf } from "@/lib/recommend";
import type { HistoryItem } from "@/stores/appStore";
import { TIcon } from "@/components/transform/TransformCard";
import { useToast } from "@/components/Toast";
import styles from "./CardActionBar.module.css";

/** 动作条最多显示几个 */
const MAX_ACTIONS = 3;

export const CardActionBar = memo(function CardActionBar({
  item,
  compact = false,
}: {
  item: HistoryItem;
  /** inline 模式空间小，用更紧凑的间距 */
  compact?: boolean;
}) {
  const { toast } = useToast();

  // 只对纯文本卡片有意义；图片/文件/图文没有可执行的目标内容。
  // v6.1：走个性化排序（含「不再推荐」剔除）。
  const entries = useMemo(() => {
    if (item.type !== "text") return [];
    const text = item.text || "";
    if (!text.trim()) return [];
    return recommendScored(
      {
        text,
        contentType: item.content_type || item.type,
        /**
         * 标签一并传进去，让三处构造 TransformContext 的地方（本栏 / AI 快捷栏 / 变换中心）
         * 保持一致的上下文。
         *
         * **它当前对本栏不产生任何效果**，得说清楚：标签只影响 AI 动作的打分
         * （languageTag 推高 ai-explain-code、tagBoost 浮出 ai-reply-draft 等），
         * 而那些全是 `kind: "text"`，下面的 `kind === "action"` 过滤会全部剔掉。
         *
         * 仍然传的理由：以后出现第一个 `kind: "action"` 的 AI 动作、或哪个本地
         * 动作的 detect 开始读 tags 时，这里不需要再想起来补一次——三处 ctx 里
         * 少一处字段，正是“为什么只有这个入口行为不一样”这类 bug 的温床。
         */
        tags: item.tags?.map((t) => ({ name: t.name, source: t.source })),
      },
      // v6.2 场景感知：当前小时 + 来源应用
      sceneOf(new Date().getHours(), item.source),
    )
      .filter((s) => s.transform.kind === "action")
      .slice(0, MAX_ACTIONS)
      .map((s) => ({ t: s.transform, text }));
  }, [item]);

  if (entries.length === 0) return null;

  const run = async (id: string, label: string, text: string) => {
    const t = getTransform(id);
    if (!t) return;
    const r = await t.run(text);
    toast(
      r.ok ? `已执行「${label}」` : (r.message || "执行失败"),
      r.ok ? "success" : "error"
    );
  };

  return (
    <div
      className={`${styles.bar}${compact ? ` ${styles.compact}` : ""}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {entries.map(({ t, text }) => (
        <button
          key={t.id}
          className={styles.btn}
          title={t.label}
          aria-label={t.label}
          onClick={() => void run(t.id, t.label, text)}
        >
          <TIcon name={t.icon} size={13} />
        </button>
      ))}
    </div>
  );
});
