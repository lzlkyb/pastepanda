import { Component, ErrorInfo, ReactNode } from "react";
import { logger } from "@/lib/logger";
import melodyUrl from "@/assets/melody.png";

interface Props {
  children: ReactNode;
  /** 崩溃时的替代 UI。
   *  传函数可拿到真实 error —— 独立窗口（截图窗等）必须把错误显示出来，否则
   *  错误只落在 webview console 里（logger 不写文件），用户看不到、排查也无从下手。 */
  fallback?: ReactNode | ((error: Error | null) => ReactNode);
  componentName?: string; // 用于错误提示的组件名称
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error("组件渲染崩溃", error, info.componentStack);
    // 发送 toast 通知（当 fallback 为 null 时用户至少能看到提示）
    const name = this.props.componentName || "组件";
    const err = this.state.error;
    const detail = {
      message: `${name}加载失败，请尝试刷新页面`,
      type: "error" as const,
      // 让 toast 的「复制」按钮直接拿到技术错误（message + stack），便于反馈 bug
      copyText: err ? `${err.message}\n\n${err.stack || ""}` : undefined,
    };
    window.dispatchEvent(new CustomEvent("app-toast", { detail }));
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const { fallback } = this.props;
      // 函数式 fallback：把真实 error 交给调用方自行渲染
      if (typeof fallback === "function") return fallback(this.state.error);
      // 显式传 fallback={null} 的意图是「崩了就别渲染，只弹 toast」（见 componentDidCatch）。
      // 旧写法 `if (fallback)` 对 null 为假，会掉进下面的默认错误界面 —— 跟 13 处
      // 调用点的意图正好相反。用 in 把「没传」和「显式传 null」分开。
      if ("fallback" in this.props) return fallback ?? null;

      // class 组件无法用 hook，直接读 documentElement 的 data-theme（applyTheme 维护）
      const isBlossom = document.documentElement.getAttribute("data-theme") === "blossom";

      return (
        <div className="error-init-state">
          <div className="error-init-icon">
            {isBlossom ? (
              <img
                src={melodyUrl}
                alt=""
                draggable={false}
                style={{ width: 64, height: 64, objectFit: "contain", filter: "drop-shadow(0 6px 16px rgba(240, 86, 140, 0.28))" }}
              />
            ) : "💥"}
          </div>
          <h3 className="error-init-title">{isBlossom ? "美乐蒂迷路了…" : "界面渲染异常"}</h3>
          <p className="error-init-desc">
            {isBlossom ? "组件发生未预期的错误，美乐蒂帮你记下了，请尝试刷新。" : "组件发生未预期的错误，请尝试刷新。"}
          </p>
          <p className="error-init-detail">{this.state.error?.message || "未知错误"}</p>
          <div className="error-init-actions">
            <button
              className="btn-init-secondary"
              onClick={() => {
                try {
                  navigator.clipboard.writeText(
                    `${this.state.error?.message}\n\n${this.state.error?.stack || ""}`
                  );
                } catch { logger.warn("复制错误详情失败"); }
              }}
            >
              📋 复制错误详情
            </button>
            <button className="btn-init-primary" onClick={this.handleReset}>
              🔄 重试渲染
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
