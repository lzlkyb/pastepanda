import { useMemo } from "react";
import { BookOpen, Smartphone } from "lucide-react";
import { MobileSheet } from "./MobileSheet";
import { UpdateFooter, UpdateStatusBody, sheetTitle } from "./MobileUpdateSheetParts";
import { useMobileUpdate } from "./MobileUpdate";
import { parseChangelogSection } from "@/lib/changelogParser";
import { countCategoryItems, type ChangeItem } from "@/lib/changelog";
import { stripBold, splitChangelogText } from "@/lib/changelogDisplay";
import styles from "./MobileUpdateSheet.module.css";

/* 与桌面 UpdateNotesDialog 同源的手册地址；两处各自持有，改动时一并核对。 */
const MANUAL_URL = "https://pastepanda.pages.dev/manual/manual.html";
const MANUAL_BACKUP_URL = "https://lzlkyb.github.io/pastepanda/manual/manual.html";

/** 单条说明：桌面/手机共用 splitChangelogText 口径（**X**：只显标题、否则拆引导词）。 */
function NoteItem({ item }: { item: ChangeItem }) {
  const d = splitChangelogText(item.text);
  return (
    <div className={styles.grpItem}>
      {d.kind === "titleOnly" ? (
        <b>{d.title}</b>
      ) : d.kind === "plain" ? (
        d.text
      ) : (
        <>
          <b>{d.lead}</b>
          {d.sep}
          {d.rest}
        </>
      )}
    </div>
  );
}

export function MobileUpdateSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const update = useMobileUpdate();
  const { status, info, installed } = update;
  const target = info?.version ?? "";

  const entry = useMemo(
    () => (info?.version ? parseChangelogSection(info.body, info.version) : null),
    [info],
  );
  const themeLine = entry ? stripBold(entry.summary) : "";

  async function openManual() {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      try {
        await openUrl(MANUAL_URL);
      } catch {
        await openUrl(MANUAL_BACKUP_URL);
      }
    } catch {
      // 非 Tauri 环境（浏览器调试）退回新标签页。
      window.open(MANUAL_URL, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <MobileSheet
      open={open}
      title={sheetTitle(status, target)}
      onClose={onClose}
      footer={<div className={styles.footRow}>
        <UpdateFooter update={update} onClose={onClose} />
      </div>}
    >
      {status === "available" ? (
        <AvailableBody entry={entry} target={target} installed={installed} themeLine={themeLine} onManual={openManual} />
      ) : (
        <UpdateStatusBody update={update} />
      )}
    </MobileSheet>
  );
}

/** available 态正文：Hero + 分组说明卡 + 手册 CTA。 */
function AvailableBody({
  entry,
  target,
  installed,
  themeLine,
  onManual,
}: {
  entry: ReturnType<typeof parseChangelogSection>;
  target: string;
  installed: string;
  themeLine: string;
  onManual: () => void | Promise<void>;
}) {
  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroTop}>
          <span className={styles.heroIco}>
            <Smartphone size={24} aria-hidden="true" />
          </span>
          <span className={styles.heroVer}>
            {installed && <span className={styles.vOld}>v{installed}</span>}
            {installed && <span className={styles.vArrow}>→</span>}
            <span className={styles.vNew}>v{target}</span>
          </span>
        </div>
        <div className={styles.heroTitle}>{themeLine || "PastePanda 更新"}</div>
      </div>

      {entry ? (
        entry.categories
          .filter((c) => countCategoryItems(c) > 0)
          .map((cat) => (
            <div className={styles.grp} key={cat.type}>
              <div className={styles.grpHead}>
                <span className={styles.chip} data-cat={cat.type}>
                  {cat.name}
                </span>
                <span className={styles.grpTitle}>
                  {cat.name} · {countCategoryItems(cat)}
                </span>
              </div>
              {(cat.items ?? []).map((item, i) => (
                <NoteItem key={i} item={item} />
              ))}
              {(cat.groups ?? []).map((g, gi) => (
                <div key={`g-${gi}`}>
                  {g.label && <div className={styles.grpSub}>{g.label}</div>}
                  {g.items.map((item, i) => (
                    <NoteItem key={i} item={item} />
                  ))}
                </div>
              ))}
            </div>
          ))
      ) : (
        <p className={styles.stateP}>本次更新说明暂不可用，仍可照常下载。</p>
      )}

      <button type="button" className={styles.manual} onClick={() => void onManual()}>
        <BookOpen size={16} aria-hidden="true" />
        查看完整功能手册
      </button>
    </>
  );
}
