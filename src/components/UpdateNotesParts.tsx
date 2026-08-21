/**
 * UpdateNotesParts —— 更新弹框的条目渲染子组件（拆出以维持主文件 ≤300 行）。
 *  GroupItem：富文本（怎么用/有什么用/配图）→ 组内 feat 卡，否则普通列表项；
 *  MediaThumb：配图缩略图（失败降级）；FallbackContent：未找到结构化日志的兜底。
 */
import { useState } from "react";
import { Illustration, isIllustrationKey } from "@/components/Illustration";
import type { ChangeItem } from "@/lib/changelog";
import styles from "./UpdateNotesDialog.module.css";

/** 剥离 markdown 加粗符号（**…**）：React 渲染纯文本不解析 markdown，
 *  CHANGELOG 条目的 ** 原样显示成星号，这里统一剥掉。 */
export function stripBold(s: string): string {
  return s.replace(/\*\*/g, "");
}

/** 「标题：说明」前缀加粗，提升扫读效率 */
function renderItemText(text: string) {
  const m = /^(.+?)(：| — )([\s\S]+)$/.exec(text);
  if (!m) return stripBold(text);
  return (
    <>
      <b>{stripBold(m[1])}</b>
      {m[2]}
      {m[3]}
    </>
  );
}

/** 单条条目：带富文本（怎么用/有什么用/配图）渲染为组内 feat 卡，否则普通列表项 */
export function GroupItem({ item }: { item: ChangeItem }) {
  const rich = item.why || (item.how && item.how.length > 0) || item.media;
  if (!rich) {
    return <div className={styles.grpItem}>{renderItemText(item.text)}</div>;
  }
  const m = /^(.+?)(：| — )([\s\S]+)$/.exec(item.text);
  const title = stripBold(m ? m[1] : item.text);
  const desc = m ? stripBold(m[3]) : "";
  return (
    <div className={styles.feat}>
      <div className={styles.featTitle}>{title}</div>
      {desc && <div className={styles.featDesc}>{desc}</div>}
      {item.why && <div className={styles.featWhy}>{item.why}</div>}
      {item.how && item.how.length > 0 && (
        <>
          <div className={styles.featHowH}>怎么用</div>
          <ol className={styles.featHow}>
            {item.how.map((s, hi) => (
              <li key={hi}>{s}</li>
            ))}
          </ol>
        </>
      )}
      {item.media && <MediaThumb src={item.media} />}
    </div>
  );
}

/** 配图缩略图：加载失败优雅降级为占位（真实资源到位后自动显示） */
function MediaThumb({ src }: { src: string }) {
  const [err, setErr] = useState(false);
  const kind = isIllustrationKey(src) ? src : null;
  return (
    <div className={styles.featMedia}>
      {kind ? (
        <Illustration kind={kind} className={styles.featMediaImg} />
      ) : err ? (
        <Illustration kind="default" className={styles.featMediaImg} />
      ) : (
        <img src={src} alt="" className={styles.featMediaImg} onError={() => setErr(true)} />
      )}
    </div>
  );
}

/** Fallback（未找到结构化日志条目） */
export function FallbackContent({ updateBody }: { updateBody?: string | null }) {
  return (
    <div className={styles.fallback}>
      <div>暂无详细更新日志</div>
      {updateBody && <div className={styles.fallbackBody}>{updateBody}</div>}
    </div>
  );
}
