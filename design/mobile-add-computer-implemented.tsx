import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MobileSheet } from "../src-mobile/ui/MobileSheet";
import { RcPairCard } from "../src-mobile/devices/RcPairCard";
import "../src/styles/theme.css";
import "../src-mobile/styles/mobile-base.css";
import "./mobile-add-computer-implemented.css";
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") || "ocean";
function Preview() {
  const [open, setOpen] = useState(true);
  return <><main className="implementation-preview"><h1>添加电脑 · B 方案</h1><p>实际组件预览，配对码和设备均为示例，不连接电脑。</p><button onClick={() => setOpen(true)}>添加电脑</button></main><MobileSheet open={open} title="添加电脑" onClose={() => setOpen(false)}>{open && <RcPairCard onPaired={() => setOpen(false)} />}</MobileSheet></>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
