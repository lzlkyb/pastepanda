/**
 * 预览面板错误边界（稿子 U3.5：预览失败**不能变成空白页**）。
 *
 * 预览组件（Markdown / JSON 结构树 / HTML 沙箱 / 表格 / 日志）在渲染期抛错时，
 * React 默认把整棵子树卸载 —— 用户看到的就是「切到预览就白屏」，而源文其实还好好的。
 * 边界兜住后持久告知发生了什么，并给两条出路：
 *   - 重试预览：重置边界（配合宿主的 key 递增强制重挂载）；
 *   - 显示源码：切回编辑视图（预览坏了，稿子没坏，编辑永远可用）。
 *
 * 类组件是 ErrorBoundary 的唯一形态（React 限制），样式走同一个 CSS module。
 */
import { Component, type ReactNode } from "react";
import styles from "../FullscreenEditor.module.css";

interface PreviewErrorBoundaryProps {
  children: ReactNode;
  /** 重试预览：宿主应递增预览 key 以强制重挂载 */
  onRetry: () => void;
  /** 显示源码：切回编辑视图 */
  onShowSource: () => void;
}

interface PreviewErrorBoundaryState {
  error: Error | null;
}

export class PreviewErrorBoundary extends Component<
  PreviewErrorBoundaryProps,
  PreviewErrorBoundaryState
> {
  state: PreviewErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PreviewErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    // 控制台留一份完整栈，界面只说人话（规则 15.3：静默失败比报错难查一个量级）
    console.warn("[FullscreenEditor] 预览渲染失败:", error);
  }

  private handleRetry = () => {
    this.setState({ error: null });
    this.props.onRetry();
  };

  render() {
    if (this.state.error) {
      return (
        <div className={styles.previewError}>
          <h5 className={styles.previewErrorTitle}>预览没有生成</h5>
          <p className={styles.previewErrorMsg}>
            {this.state.error.message || "渲染过程中出现了意外错误。"}
            你的源文和未保存修改都还在。
          </p>
          <div className={styles.previewErrorActions}>
            <button type="button" className={styles.previewErrorBtnPrimary} onClick={this.handleRetry}>
              重试预览
            </button>
            <button type="button" className={styles.previewErrorBtn} onClick={this.props.onShowSource}>
              显示源码
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
