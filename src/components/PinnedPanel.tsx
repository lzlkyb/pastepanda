import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pin, RotateCw, FlipHorizontal, X } from "lucide-react";
import { logger } from "@/lib/logger";
import styles from "./PinnedPanel.module.css";

/** 贴图管理面板（V6.19）：托盘"贴图管理"→ 主窗口弹层。
 *  列表显示当前所有置顶贴图，支持复制 / 重新编辑 / 关闭单张 / 关闭全部。 */
export default function PinnedPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [paths, setPaths] = useState<string[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  /**
   * 列表读取失败原因。null = 没失败过。
   *
   * 🔴 旧实现的 catch 里只有 `logger.warn`，`paths` 保持 `[]`，
   * 于是渲染出「暂无置顶贴图 · 截图后点『贴图置顶』…」——
   * 把「读不出来」渲染成了「你没有贴图」（U3.5）。
   * 发布版没有控制台，`logger.warn` 等于什么都没留。
   */
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await invoke<string[]>("list_pinned_images");
      setPaths(list);
      const t: Record<string, string> = {};
      for (const p of list) {
        try {
          t[p] = await invoke<string>("get_image_data_url", { path: p });
        } catch {
          /* 单张缩略图读不出来不影响整份列表：行还在，只是占位图 */
        }
      }
      setThumbs(t);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLoadError(msg);
      logger.warn("贴图列表加载失败", e);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  if (!open) return null;

  const copyOne = async (path: string) => {
    try {
      await invoke("copy_image_only", { imagePath: path });
      setCopied(path);
      setTimeout(() => setCopied(null), 1200);
    } catch (e) {
      logger.warn("复制贴图失败", e);
    }
  };

  // 管理面板"旋转/翻转"：action 1=旋转90° 2=水平翻转（垂直翻转/恢复用贴图右键菜单或快捷键）
  const transformOne = (path: string, action: number) => {
    void invoke("transform_pinned_image_by_path", { path, action }).catch((e) =>
      logger.warn("贴图变换失败", e),
    );
  };

  const editOne = (path: string) => {
    void invoke("open_pinned_edit", { path }).catch((e) => logger.warn("重编辑失败", e));
    onClose();
  };

  const closeOne = (path: string) => {
    void invoke("close_pinned_image_by_path", { path });
    setPaths((prev) => prev.filter((p) => p !== path));
  };

  const closeAll = () => {
    void invoke("close_pinned_image");
    setPaths([]);
  };

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.panel}>
        <div className={styles.head}>
          <span className={styles.title}>
            <Pin size={14} /> 贴图管理
          </span>
          <span className={styles.count}>
            {paths.length > 0 ? `${paths.length} 张贴图置顶中` : "当前无贴图"}
          </span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </div>

        <div className={styles.list}>
          {loadError ? (
            // 失败态必须与「真的没贴图」可区分，并自带重试（U3.3 / U3.5）。
            <div className={styles.loadError}>
              <span>读不到贴图列表：{loadError}</span>
              <button type="button" className={styles.retryBtn} onClick={() => void load()}>
                重试
              </button>
            </div>
          ) : paths.length === 0 ? (
            <div className={styles.empty}>
              暂无置顶贴图 · 截图后点「贴图置顶」即可钉在屏幕上
            </div>
          ) : null}

          {paths.map((p) => (
            <div key={p} className={styles.row}>
              <div className={styles.thumb}>
                {thumbs[p] ? (
                  <img src={thumbs[p]} alt="" />
                ) : (
                  <span className={styles.thumbPh}>…</span>
                )}
              </div>
              <span className={styles.name} title={p}>
                {p.split(/[\\/]/).pop()}
              </span>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => transformOne(p, 1)}
                title="旋转 90°"
                aria-label="旋转 90度"
              >
                <RotateCw size={12} />
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => transformOne(p, 2)}
                title="水平翻转"
                aria-label="水平翻转"
              >
                <FlipHorizontal size={12} />
              </button>
              <button type="button" className={styles.textBtn} onClick={() => void copyOne(p)}>
                {copied === p ? "已复制 ✓" : "复制"}
              </button>
              <button type="button" className={styles.textBtn} onClick={() => editOne(p)}>
                编辑
              </button>
              <button
                type="button"
                className={`${styles.textBtn} ${styles.dangerBtn}`}
                onClick={() => closeOne(p)}
              >
                关闭
              </button>
            </div>
          ))}
        </div>

        {paths.length > 0 && (
          <div className={styles.foot}>
            <button
              type="button"
              className={`${styles.textBtn} ${styles.dangerBtn}`}
              onClick={closeAll}
            >
              关闭全部贴图
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
