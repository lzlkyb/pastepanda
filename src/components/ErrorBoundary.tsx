import { Component, ErrorInfo, ReactNode } from "react";
import { logger } from "@/lib/logger";
import melodyUrl from "@/assets/melody.png";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
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
      if (this.props.fallback) return this.props.fallback;

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
