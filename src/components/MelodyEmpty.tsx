import { memo } from "react";
import { useAppStore } from "@/stores/appStore";
import melodyUrl from "@/assets/melody.png";

/**
 * 美乐蒂空状态立绘 — 仅在 blossom 主题下渲染浮动小立绘，
 * 供各弹窗/面板的块级空状态复用（紧凑文本型空状态不适用）。
 * 非 blossom 主题返回 null，由调用方保留原有图标/文案。
 */
export const MelodyEmpty = memo(function MelodyEmpty({ size = 72 }: { size?: number }) {
  const theme = useAppStore((s) => s.config.theme);
  if (theme !== "blossom") return null;
  return (
    <img
      src={melodyUrl}
      alt=""
      draggable={false}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        display: "block",
        margin: "0 auto",
        filter: "drop-shadow(0 6px 16px rgba(240, 86, 140, 0.28))",
        animation: "melody-empty-float 3.2s ease-in-out infinite",
      }}
    />
  );
});
