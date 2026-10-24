import styles from "./WindowCrashFallback.module.css";

/**
 * 独立悬浮窗的崩溃兜底（批次③）。
 *
 * 🔴 这些窗口（远程协助申请卡 / 栈浮标 / 待办岛 / 长截图状态窗）生命周期贯穿
 * 整个应用会话，渲染期抛错时若没有兜底 = 白屏死掉且只能重启应用。
 * 它们是独立 webview，拿不到主窗口的 app-toast 事件——错误展示必须
 * 自给自足：一句人话 + 重新加载按钮。
 */
export function WindowCrashFallback({ label }: { label: string }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.title}>{label}出了点问题</div>
      <button type="button" className={styles.reload} onClick={() => window.location.reload()}>
        重新加载
      </button>
    </div>
  );
}
