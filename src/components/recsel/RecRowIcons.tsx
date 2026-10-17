/**
 * RecRowIcons — 「最近录制」行内图标（设计稿 §06）。
 *
 * 与设计稿 symbol 定义逐路径一致（24 视窗、stroke 1.7、currentColor），
 * 由 CSS 控制尺寸（默认 14px）。全部 aria-hidden：行内的可访问名由文字按钮承担，
 * 图标只是让「删除」这类危险项在菜单里被先看见（U4 的语义色 + 图标双通道）。
 */
type IconProps = { className?: string };

const stroke = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
} as const;

/** 影片块：56×34 缩略位里的主视觉，替代原来的 13px emoji。 */
export function IconFilm({ className }: IconProps) {
  return (
    <svg {...stroke} className={className}>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M8 5v14M16 5v14M3 9.5h5M3 14.5h5M16 9.5h5M16 14.5h5" />
    </svg>
  );
}

/** 主路径动作：预览与裁剪。 */
export function IconScissors({ className }: IconProps) {
  return (
    <svg {...stroke} className={className}>
      <circle cx="6.5" cy="7" r="2.5" />
      <circle cx="6.5" cy="17" r="2.5" />
      <path d="M8.7 8.4 19 17M8.7 15.6 19 7" />
    </svg>
  );
}

/** ⋯ 触发器：长尾动作的入口（打开文件夹 / 导出 GIF / 删除）。 */
export function IconMore({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false" className={className}>
      <circle cx="6" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="18" cy="12" r="1.8" />
    </svg>
  );
}

/** 菜单项：打开文件夹。 */
export function IconFolder({ className }: IconProps) {
  return (
    <svg {...stroke} className={className}>
      <path d="M3 7V5.5h6.5l2 3H21V19H3z" />
    </svg>
  );
}

/** 菜单项：导出 GIF。 */
export function IconGif({ className }: IconProps) {
  return (
    <svg {...stroke} className={className}>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M8 10.5h2v3H8zM13 10.5v3M13 10.5h2.5" />
    </svg>
  );
}

/** 菜单项：删除（不可恢复，U4 语义色）。 */
export function IconTrash({ className }: IconProps) {
  return (
    <svg {...stroke} className={className}>
      <path d="M4 7h16M9.5 7V5h5v2M6.5 7l1 12.5h9L17.5 7" />
    </svg>
  );
}
