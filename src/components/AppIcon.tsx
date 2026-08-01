import { memo } from "react";
import { useAppStore } from "@/stores/appStore";
import melodyUrl from "@/assets/melody.png";

export interface AppIconProps {
  /** 尺寸，默认 24 */
  size?: number;
  /** 额外的 className */
  className?: string;
}

/**
 * 统一的应用图标组件。
 * 图标来源：public/icon.png（与 src-tauri/icons/icon.png 保持一致）。
 * 所有 Logo 显示位置都通过此组件引用，换图标只需替换 public/icon.png。
 * blossom 主题下自动切换为美乐蒂官方立绘，配合沉浸式皮肤体验。
 */
export const AppIcon = memo(function AppIcon({ size = 24, className }: AppIconProps) {
  const theme = useAppStore((s) => s.config.theme);
  const src = theme === "blossom" ? melodyUrl : "/icon.png";
  return (
    <img
      src={src}
      alt="PastePanda"
      width={size}
      height={size}
      className={className}
      style={{ width: size, height: size, flexShrink: 0 }}
      draggable={false}
    />
  );
});

export default AppIcon;
