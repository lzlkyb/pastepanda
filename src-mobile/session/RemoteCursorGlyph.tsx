/**
 * RemoteCursorGlyph — 手机端的「电脑光标」图形（B 方案，2026-10-02）。
 *
 * 为什么要有它：被控端的视频帧里**没有**光标（DXGI 桌面复制不含指针，
 * `dxgi.rs` 也没有合成），手机只能看到一个本地环——本机鼠标一有 hover
 * 副作用、用户从别处动了鼠标，那个环就开始撒谎。现在被控端把「光标形状 +
 * 归一化位置」随控制帧推过来，这里画**真的**光标。
 *
 * 形状取舍：Windows 标准光标有十几种，这里只画语义最明显的两种图形——
 * 箭头（arrow / unknown / 未识别形状的默认）和 I-beam（文本输入位）。
 * 其余形状（缩放柄 / 禁止 / 等待……）仍用箭头外观：手机上没有悬停概念，
 * 这些形状的辨识收益低于多带 10 个 SVG 路径的维护成本；**hidden 例外**，
 * 它必须真的收起光标（远端在游戏/演示里藏了光标，摆个假的就是说谎）。
 *
 * 配色：白填充 + 深色描边（真实系统光标的双色描边思路），保证在浅色和
 * 深色画面上都能看清；不依赖主题变量，因为画面本身没有主题。
 */
export function RemoteCursorGlyph({ shape }: { shape: string }) {
  // hidden：不渲染。远端把光标藏了，手机这边摆一个就是「光标明明不在那」。
  if (shape === "hidden") return null;

  return (
    <svg
      className="rcCursorGlyph"
      viewBox="0 0 24 24"
      width="28"
      height="28"
      aria-hidden="true"
      focusable="false"
    >
      {shape === "ibeam" ? (
        // I-beam：文本输入位（输入框 / 编辑器 / 地址栏）。
        <g fill="none" stroke="#111827" strokeWidth="3.2" strokeLinecap="round">
          <path d="M7 3.5 H17 M12 3.5 V20.5 M7 20.5 H17" />
        </g>
      ) : (
        // 箭头：默认形状。白填充 + 深描边，深浅底都看得见。
        <path
          d="M3 2 L3 18.5 L7.8 14 L10.8 20.5 L14 19 L11 12.8 L18.6 12.8 Z"
          fill="#ffffff"
          stroke="#111827"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
