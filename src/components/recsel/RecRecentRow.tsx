/**
 * RecRecentRow — 「最近录制」的一行（设计稿 §06：一行两枚动作）。
 *
 * 改前每行最多并列 4–6 枚 11px 文字 chip（预览与裁剪 / 打开文件夹 / 导出 GIF /
 * 删除 / 确认删除 / 保留），动作数量和文件名一样抢眼。现在收成「一枚主按钮 + 一个 ⋯ 菜单」：
 * 主路径留文字按钮，长尾进菜单，删除走行内二次确认（整行描边转红，不再是两枚并排红 chip）。
 *
 * GIF 导出的各态都落在**这一行里**：进行中 = 行内进度条 + 取消；失败 = 行内 alert + 重新查询；
 * 完成 = 主按钮变成「打开 GIF」。提示写在它所属的行，不在列表底部放全局条。
 *
 * 🔴 ⋯ 菜单用 `hidden` 属性开合（不是拆挂载）：`getByRole` 拿不到隐藏菜单里的按钮，
 *    读屏与「Tab 到一堆看不见的按钮」都不会发生；代价是每次开合重放入场动画，正是想要的。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { recDeleteFile, recOpenFile, recOpenPreview, recReveal, type RecFileMeta } from "@/lib/api/rec";
import { formatBytes, formatRecordingTime } from "@/lib/utils";
import type { useRecGifExport } from "@/hooks/useRecGifExport";
import { RecTrimRecovery } from "./RecTrimRecovery";
import { IconFilm, IconFolder, IconGif, IconMore, IconScissors, IconTrash } from "./RecRowIcons";
import styles from "./RecRecentList.module.css";

type Gif = ReturnType<typeof useRecGifExport>;

export function RecRecentRow({
  file,
  gif,
  run,
  reload,
}: {
  file: RecFileMeta;
  gif: Gif;
  /** 列表级错误通道：行内动作失败统一冒泡到 section 尾部（不和各行抢位置）。 */
  run: (action: () => Promise<unknown>) => void;
  reload: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const task = gif.task?.source === file.path ? gif.task : null;
  const running = !!task?.running;
  const done = !!task?.donePath;

  // 删除确认只给 3 秒：过时不认，防止「瞄见一行是红的就顺手点一下」
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  // 点别处 / Esc 收菜单。监听挂 document 而不是按钮 blur：菜单项自己也是按钮，
  // 点一项之后焦点还在菜单里，blur 路线会把自己刚打开的菜单当场关掉。
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const remove = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    run(async () => {
      await recDeleteFile(file.path);
      reload();
    });
  };
  const act = (action: () => Promise<unknown>) => {
    setMenuOpen(false);
    run(action);
  };

  // 一个后台任务未知时，全表的启动位都disable：不让两个源抢同一个导出器
  const gifStartDisabled =
    !!gif.starting || gif.restoring || !!gif.restoreError || !!gif.task?.running || !!gif.task?.queryFailed;
  const gifLabel = gif.starting === file.path ? "正在启动…" : task?.error ? "重试 GIF" : done ? "重新导出 GIF" : "导出 GIF";

  return (
    <div className={`${styles.item}${armed ? ` ${styles.armed}` : ""}`} role="listitem" ref={rootRef}>
      <div className={styles.thumb}>
        <IconFilm />
        {file.durationMs ? <span className={styles.dur}>{formatRecordingTime(file.durationMs)}</span> : null}
      </div>
      <div className={styles.info}>
        <button
          type="button"
          className={styles.name}
          title={`播放 ${file.name}`}
          onClick={() => run(() => recOpenFile(file.path))}
        >
          {file.name}
        </button>
        <span className={styles.meta}>
          {formatBytes(file.bytes)}
          {file.durationMs ? null : " · 时长未知"}
        </span>
        {file.note ? <span className={styles.bad}>{file.note}</span> : null}
        <RecTrimRecovery path={file.path} />
        {running && task && (
          <div className={styles.progress}>
            <div
              className={styles.pbar}
              role="progressbar"
              aria-label="GIF 导出进度"
              aria-valuenow={task.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              {/* ui-rule-ok: 进度宽度是运行期百分比，静态样式表达不了（进度条无 CSS 写法） */}
              <i style={{ "--p": `${task.percent}%` } as CSSProperties} />
            </div>
            <span className={styles.pct}>GIF 正在导出 · {task.percent}%</span>
            <button type="button" className={styles.link} onClick={() => void gif.cancel()}>
              取消导出 GIF
            </button>
          </div>
        )}
        {task?.error && (
          <p className={styles.err} role="alert">
            {task.error}。原录像保留。
            {task.queryFailed && (
              <button type="button" className={styles.link} onClick={() => void gif.query(file.path)}>
                重新查询 GIF
              </button>
            )}
          </p>
        )}
      </div>
      <div className={styles.ops}>
        {armed ? (
          <>
            <button type="button" className={`${styles.btn} ${styles.btnArm}`} onClick={remove}>
              确认删除？
            </button>
            <button type="button" className={`${styles.btn} ${styles.btnText}`} onClick={() => setArmed(false)}>
              保留
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnOutline}`}
              onClick={() => act(done ? () => recOpenFile(task!.donePath!) : () => recOpenPreview(file.path))}
            >
              <IconScissors />
              {done ? "打开 GIF" : "预览与裁剪"}
            </button>
            <div className={styles.menu}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnIcon}`}
                aria-label="更多操作"
                title="更多操作"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <IconMore />
              </button>
              <div className={styles.pop} hidden={!menuOpen}>
                {done && (
                  <button type="button" className={styles.mi} onClick={() => act(() => recOpenPreview(file.path))}>
                    <IconScissors />
                    预览与裁剪
                  </button>
                )}
                <button type="button" className={styles.mi} onClick={() => act(() => recReveal(file.path))}>
                  <IconFolder />
                  打开文件夹
                </button>
                {!running && (
                  <button
                    type="button"
                    className={styles.mi}
                    disabled={gifStartDisabled}
                    onClick={() => act(() => gif.start(file.path))}
                  >
                    <IconGif />
                    {gifLabel}
                  </button>
                )}
                {done && (
                  <button type="button" className={styles.mi} onClick={() => act(() => recReveal(task!.donePath!))}>
                    <IconFolder />
                    定位 GIF 文件
                  </button>
                )}
                {done && <div className={styles.dash} />}
                <button
                  type="button"
                  className={`${styles.mi} ${styles.miDanger}`}
                  onClick={() => {
                    setMenuOpen(false);
                    setArmed(true);
                  }}
                >
                  <IconTrash />
                  删除
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
