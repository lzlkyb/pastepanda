import { createRoot } from "react-dom/client";
import { TouchSandbox } from "../../src-mobile/dev/TouchSandbox";
import "../../src/styles/theme.css";
import "../../src-mobile/styles/mobile-base.css";

// Reuse the actual mobile session; no session id is supplied and no real device is connected.
createRoot(document.getElementById("root")!).render(<TouchSandbox onExit={() => location.reload()} />);
