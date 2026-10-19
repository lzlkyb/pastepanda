/**
 * 预览窗的失败反馈与补救入口（2026-10-18 从 RecPreview 抽出：容器已贴 300 行红线）。
 *
 * 一条规矩：**每一条错误都带一个能立刻按的补救键**，或者能说清为什么没有
 * （「裁剪状态读取失败」给「重新查询裁剪」，「GIF 发现失败」给「重新查询 GIF」）。
 * 错误正文统一归到 `.rec-pv-err`（`role="alert"`），补救键各自成行，
 * 因为读屏在 alert 里塞一排按钮会念成一长串。
 */
export function PreviewNotices({
  videoBlocked,
  keyframesFailed,
  trimQueryFailed,
  gifRestoreFailed,
  error,
  onSystemPlayer,
  onRetryKeyframes,
  onRetryTrim,
  onRetryGif,
}: {
  videoBlocked: boolean;
  keyframesFailed: boolean;
  trimQueryFailed: boolean;
  gifRestoreFailed: boolean;
  /** 已经拼好的一条人话（各来源用「；」连接）。 */
  error: string;
  onSystemPlayer: () => void;
  onRetryKeyframes: () => void;
  onRetryTrim: () => void;
  onRetryGif: () => void;
}) {
  const fix = (label: string, onClick: () => void) => (
    <div className="rec-pv-errorRow">
      <button type="button" className="rec-pv-btn" onClick={onClick}>
        {label}
      </button>
    </div>
  );
  return (
    <>
      {videoBlocked && fix("用系统播放器打开", onSystemPlayer)}
      {keyframesFailed && fix("重试时间轴", onRetryKeyframes)}
      {trimQueryFailed && fix("重新查询裁剪", onRetryTrim)}
      {gifRestoreFailed && fix("重新查询 GIF", onRetryGif)}
      {error && (
        <div className="rec-pv-err" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
