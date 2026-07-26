import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { TrayPopup } from "./components/TrayPopup";
import { applyTheme, DEFAULT_THEME } from "./lib/theme";
import "./styles/globals.css";
import "./styles/popup.css";

// 弹出窗口默认使用主窗口当前主题
applyTheme(DEFAULT_THEME);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <TrayPopup />
    </MotionConfig>
  </React.StrictMode>,
);
