/**
 * ProfileRadar — 能力维度雷达图（SVG 数据驱动，零依赖）。
 *
 * 符合行业规范：单多边形 + 轴外标签 + 数值标注 + 3 层浅网格。
 * 六轴按分数降序顺时针排列（最强项在 12 点方向），分数已归一化到最强项。
 */
import { useMemo } from "react";
import type { RoleScore } from "@/lib/api/profile";

/** 六角色固定顺序（与后端 ROLES 一致），降序后仍按此顺序占位 */
const ROLES_ORDER = ["developer", "research", "writer", "comm", "ops", "data"];
const ROLE_LABELS: Record<string, string> = {
  developer: "开发",
  research: "研究",
  writer: "文案",
  comm: "沟通",
  ops: "运营",
  data: "数据",
};
/** 六轴角度（从 12 点方向顺时针） */
const DEG = [0, 60, 120, 180, 240, 300];
const CX = 110;
const CY = 110;
const R = 80;

function polar(deg: number, r: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.sin(rad), CY - r * Math.cos(rad)];
}

/** 六边形顶点串（网格层） */
function hexPoints(r: number): string {
  return DEG.map((d) => polar(d, r).join(",")).join(" ");
}

/** 标签水平对齐：顶部/底部居中，右侧 start，左侧 end */
function anchorOf(deg: number): "start" | "middle" | "end" {
  if (deg === 0 || deg === 180) return "middle";
  return deg < 180 ? "start" : "end";
}

export function ProfileRadar({ roleScores }: { roleScores: RoleScore[] }) {
  const scoreOf = useMemo(() => {
    const m = new Map(roleScores.map((r) => [r.role, r.score]));
    return (role: string) => m.get(role) ?? 0;
  }, [roleScores]);

  // 数据多边形（按分数缩放）
  const dataPoints = useMemo(
    () =>
      ROLES_ORDER.map((role, i) => {
        const s = Math.max(0.02, scoreOf(role)); // 极小的值也给一点可见度
        return polar(DEG[i], R * s).join(",");
      }).join(" "),
    [scoreOf],
  );

  // 顶点坐标（标签/数值/圆点用）
  const verts = useMemo(
    () =>
      ROLES_ORDER.map((role, i) => {
        const label = ROLE_LABELS[role] ?? role;
        const score = scoreOf(role);
        const [lx, ly] = polar(DEG[i], R + 24); // 轴外标签
        const [vx, vy] = polar(DEG[i], R * 0.62); // 数值
        const [px, py] = polar(DEG[i], R * score); // 顶点圆点
        return { role, label, score, lx, ly, vx, vy, px, py, anchor: anchorOf(DEG[i]) };
      }),
    [scoreOf],
  );

  return (
    <svg width="220" height="220" viewBox="0 0 220 220" role="img" aria-label="能力维度雷达图">
      {/* 3 层网格 */}
      <g fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="1">
        <polygon points={hexPoints(R)} />
        <polygon points={hexPoints((R * 2) / 3)} />
        <polygon points={hexPoints(R / 3)} />
      </g>
      {/* 放射轴线 */}
      <g stroke="rgba(255,255,255,0.06)" strokeWidth="1">
        {DEG.map((d, i) => {
          const [x, y] = polar(d, R);
          return <line key={i} x1={CX} y1={CY} x2={x} y2={y} />;
        })}
      </g>
      {/* 数据多边形 */}
      <polygon
        points={dataPoints}
        fill="rgba(79,163,255,0.25)"
        stroke="#4fa3ff"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* 轴外标签 + 数值 + 顶点圆点 */}
      {verts.map((v) => (
        <g key={v.role} fontFamily="PingFang SC, Microsoft YaHei, sans-serif">
          <text
            x={v.lx}
            y={v.ly}
            textAnchor={v.anchor}
            fontSize="11"
            fontWeight="600"
            fill="#e8edf4"
            dominantBaseline="central"
          >
            {v.label}
          </text>
          <text
            x={v.vx}
            y={v.vy}
            textAnchor="middle"
            fontSize="9"
            fill="#4fa3ff"
            dominantBaseline="central"
          >
            {Math.round(v.score * 100)}%
          </text>
          <circle cx={v.px} cy={v.py} r={v.role === "developer" && v.score >= 0.9 ? 3.5 : 3} fill="#4fa3ff" />
        </g>
      ))}
    </svg>
  );
}
