import { useState } from "react";
import { Check, RotateCcw, Scissors, TriangleAlert, X } from "lucide-react";
import { recOpenPreview, recReveal, recRerecord, type RecHudData } from "@/lib/api/rec";
import { formatBytes, formatRecordingTime, recordingParentDir } from "@/lib/utils";
import { recQualityOf } from "@/lib/recQuality";
import styles from "./RecOffice.module.css";

/**
 * 录屏结果卡（HUD 与主窗共用）。关闭通知不删除录像，异常摘要与产物同域。
 *
 * 2026-10-16 苹果风重做（设计稿 §4）：原来是 5 个 `<p>` 平铺成的文档，
 * 现在组织成六段 —— 状态头 / 三格指标 / 文件去向 / 异常 / 动作 / 尾注：
 * ① **状态头用图标 + 文字**：26px 圆形成败图标替代「15px 绿色加粗字」的单色表意
 *    （U7：不能只靠颜色）；
 * ② **指标成组**：时长 / 体积 / 画质三格，不再挤在 `2:44 · 22.7 MB · 高清` 一行里；
 * ③ **路径与动作同行**：「打开文件夹」改成路径行内的就地动作（L5），
 *    动作区里那枚重复的「打开文件夹」随之删掉（§5.2：同一动作一屏只出现一次）；
 * ④ **异常只说事实**（`未检测到系统声音` / `保存目录不可写`），怎么办由旁边那枚按钮回答；
 *    尾部的「可在『工具 → 最近录制』找回」（与路径行重复）与「失败原因已写入日志」删掉，
 *    只留 `录制内容不会保留` 这条后果。
 */
export function RecResultCard({ data, onClose }: { data: RecHudData; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const fileName = data.path ? data.path.split(/[/\\]/).pop() : null;
  return (
    <section className={styles.result} aria-label="录屏结果">
      <div className={styles.rhead}>
        <span className={`${styles.ic}${data.ok ? "" : ` ${styles.icBad}`}`} aria-hidden="true">
          {data.ok ? <Check size={15} /> : <TriangleAlert size={15} />}
        </span>
        <b>{data.ok ? "录像已保存" : "没能保存录像"}</b>
        <button type="button" className={styles.iconBtn} onClick={onClose} title="关闭结果" aria-label="关闭结果">
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      {data.ok && (
        <div className={styles.metrics}>
          <div className={styles.m}>
            <div className={styles.mk}>时长</div>
            <div className={styles.mv}>{data.durationMs == null ? "未知" : formatRecordingTime(data.durationMs)}</div>
          </div>
          <div className={styles.m}>
            <div className={styles.mk}>体积</div>
            <div className={styles.mv}>{data.bytes == null ? "未知" : formatBytes(data.bytes)}</div>
          </div>
          <div className={styles.m}>
            <div className={styles.mk}>画质</div>
            <div className={styles.mv}>{data.quality ? recQualityOf(data.quality).label : "未知"}</div>
          </div>
        </div>
      )}
      {fileName && data.path && (
        <div className={styles.fileline}>
          <span className={styles.fn}>{fileName}</span>
          <span className={styles.fp}>
            <span>{recordingParentDir(data.path)}</span>
            <button type="button" disabled={busy} onClick={() => void run(() => recReveal(data.path!))}>
              打开文件夹
            </button>
          </span>
        </div>
      )}
      {data.note && (
        <div className={styles.warn} role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>{data.note}</span>
        </div>
      )}
      {!data.ok && (
        <div className={styles.warn} role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>{data.message || "没能保存录像"}</span>
        </div>
      )}
      {error && (
        <div className={styles.warn} role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      <div className={styles.racts}>
        {data.ok && data.path && (
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            onClick={() => void run(() => recOpenPreview(data.path!))}
          >
            <Scissors size={13} aria-hidden="true" />
            预览并裁剪
          </button>
        )}
        <button
          type="button"
          className={styles.textBtn}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await recRerecord();
              onClose();
            })
          }
        >
          <RotateCcw size={13} aria-hidden="true" />
          再录一次
        </button>
      </div>
      {!data.ok && <span className={styles.rfoot}>录制内容不会保留</span>}
      <span className={styles.rfoot} role="status">{busy ? "正在打开…" : ""}</span>
    </section>
  );
}
