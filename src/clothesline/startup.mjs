import { mountClothesline } from './runtime.mjs';

export async function startClothesline(bridge) {
  try { return await mountClothesline(bridge); }
  catch (error) {
    bridge.dispose();
    const message = '晾衣绳加载失败，图片历史保留 · 可在设置中重试显示 · ' + String(error);
    const feedback = document.getElementById('toast');
    if (feedback) { feedback.textContent = message; feedback.hidden = false; }
    // The rope has not reached ready: its own toast is still in a hidden WebView.
    await bridge.reportError(message).catch(() => {});
    return undefined;
  }
}
