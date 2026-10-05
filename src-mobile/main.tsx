import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// 复用桌面端的设计令牌体系（--app-bg / --text-primary / --accent 等，6 套主题同源）。
// 移动端视觉稿定稿后只增不改：令牌单一数据源在 src/styles/theme.css。
import "../src/styles/theme.css";
import "./styles/mobile-base.css";

// createRoot().render() 首次挂载是同步的：App 的不透明底色铺好后，
// 启动占位（index.html 的 #boot，防 WebView 冷启动白屏）就可以让位了。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
document.getElementById("boot")?.remove();
