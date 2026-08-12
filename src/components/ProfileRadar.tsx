/**
 * ProfileRadar — 能力维度雷达图（SVG 数据驱动，零依赖）。
 *
 * 符合行业规范：单多边形 + 轴外标签 + 数值标注 + 3 层浅网格。
 * 六轴按 ROLES_ORDER 的固定顺序顺时针排列（12 点恒为「开发」），分数已归一化到最强项。
 * （原注释声称「按分数降序、最强项在 12 点」，与实现不符：ROLES_ORDER 写死不排序，故删除。）
 */
import { useMemo, type CSSProperties } from "react";
import type { RoleScore } from "@/lib/api/profile";

/**
 * 六角色固定顺序（与后端 src-tauri/src/data_store/profile.rs 的 ROLES 手写保持一致）——
 * 加角色必须两端同步改，否则雷达轴与后端统计对不上。
 */
export const ROLES_ORDER = ["developer", "research", "writer", "comm", "ops", "data"];
const ROLE_LABELS: Record<string, string> = {
  developer: "开发",
  research: "研究",
  writer: "文案",
  comm: "沟通",
  ops: "运营",
  data: "数据",
};
/** 六轴角度（从 12 点方向顺时针） */
export const DEG = [0, 60, 120, 180, 240, 300];
const CX = 110;
const CY = 110;
const R = 80;
/** 数值为 0 也留一点可见度，否则多边形退化成一个点 */
const MIN_VISIBLE = 0.02;
const FONT = "PingFang SC, Microsoft YaHei, sans-serif";

/*
 * ===== 主题色 =====
 *
 * 原先这里是 7 处写死的深色值（rgba(255,255,255,.09) / #e8edf4 / #4fa3ff），
 * 只在 midnight / ocean-dark 两套深色主题下成立；ocean / forest / blossom / dawn
 * 的 --card-bg 都是 #fff，白底上网格和轴线直接消失、近白的轴标签几乎读不出来。
 *
 * 为什么统一走行内 style 而不是 fill="var(--x)"：CSS 自定义属性只在「CSS 声明」里求值，
 * presentation attribute 走的是 XML 属性通道，var() 在部分引擎里不做替换；
 * 行内 style 本身就是一条 CSS 声明，var() 必然生效，也不必为一个组件新开 CSS module。
 */
const GRID: CSSProperties = { stroke: "var(--border-color)" };
/** 轴线比网格再淡一档——同一个变量配透明度，不再额外引入色值 */
const AXIS: CSSProperties = { stroke: "var(--border-color)", strokeOpacity: 0.65 };
const LABEL: CSSProperties = { fill: "var(--text-primary)" };
const VALUE: CSSProperties = { fill: "var(--accent-strong)" };
const DOT: CSSProperties = { fill: "var(--accent)" };
/** 多边形跟随主题强调色，blossom（粉）/ dawn（橙）/ forest（绿）下不再是一块脱节的蓝 */
const AREA: CSSProperties = {
  fill: "color-mix(in srgb, var(--accent) 25%, transparent)",
  stroke: "var(--accent)",
};
const HINT: CSSProperties = { fill: "var(--text-secondary)" };

/** 极坐标 → SVG 坐标（deg 从 12 点方向顺时针） */
export function polar(deg: number, r: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.sin(rad), CY - r * Math.cos(rad)];
}

/** 六边形顶点串（网格层） */
export function hexPoints(r: number): string {
  return DEG.map((d) => polar(d, r).join(",")).join(" ");
}

/** 标签水平对齐：顶部/底部居中，右侧 start，左侧 end */
export function anchorOf(deg: number): "start" | "middle" | "end" {
  if (deg === 0 || deg === 180) return "middle";
  return deg < 180 ? "start" : "end";
}

/** 角色 → 分数查表（缺失记 0）。导出供测试：纯函数，不依赖 React */
export function radarScoreOf(roleScores: RoleScore[]): (role: string) => number {
  const m = new Map(roleScores.map((r) => [r.role, r.score]));
  return (role: string) => m.get(role) ?? 0;
}

/** 有没有真数据：全新用户传进来是空数组，也可能六项全 0 */
export function hasRadarData(roleScores: RoleScore[]): boolean {
  return roleScores.some((r) => r.score > 0);
}

/** 数据多边形的 points 串（按分数缩放） */
export function radarAreaPoints(roleScores: RoleScore[]): string {
  const scoreOf = radarScoreOf(roleScores);
  return ROLES_ORDER.map((role, i) =>
    polar(DEG[i], R * Math.max(MIN_VISIBLE, scoreOf(role))).join(","),
  ).join(" ");
}

/** 一个轴的全部绘制数据（标签 / 数值 / 顶点圆点坐标） */
export interface RadarVert {
  role: string;
  label: string;
  score: number;
  /** 轴外标签坐标 */
  lx: number;
  ly: number;
  /** 数值标注坐标 */
  vx: number;
  vy: number;
  /** 顶点圆点坐标 */
  px: number;
  py: number;
  anchor: "start" | "middle" | "end";
}

/** 六轴顶点数据（纯几何计算，导出供测试） */
export function radarVerts(roleScores: RoleScore[]): RadarVert[] {
  const scoreOf = radarScoreOf(roleScores);
  return ROLES_ORDER.map((role, i) => {
    const label = ROLE_LABELS[role] ?? role;
    const score = scoreOf(role);
    const [lx, ly] = polar(DEG[i], R + 24);
    const [vx, vy] = polar(DEG[i], R * 0.62);
    const [px, py] = polar(DEG[i], R * score);
    return { role, label, score, lx, ly, vx, vy, px, py, anchor: anchorOf(DEG[i]) };
  });
}

export function ProfileRadar({ roleScores }: { roleScores: RoleScore[] }) {
  const hasData = useMemo(() => hasRadarData(roleScores), [roleScores]);
  const dataPoints = useMemo(() => radarAreaPoints(roleScores), [roleScores]);
  const verts = useMemo(() => radarVerts(roleScores), [roleScores]);

  return (
    <svg
      width="220"
      height="220"
      viewBox="0 0 220 220"
      role="img"
      aria-label={hasData ? "能力维度雷达图" : "能力维度雷达图（行为样本不足）"}
    >
      {/* 3 层网格 */}
      <g fill="none" style={GRID} strokeWidth="1">
        <polygon points={hexPoints(R)} />
        <polygon points={hexPoints((R * 2) / 3)} />
        <polygon points={hexPoints(R / 3)} />
      </g>
      {/* 放射轴线 */}
      <g style={AXIS} strokeWidth="1">
        {DEG.map((d, i) => {
          const [x, y] = polar(d, R);
          return <line key={i} x1={CX} y1={CY} x2={x} y2={y} />;
        })}
      </g>
      {/* 数据多边形；空态另说 */}
      {hasData ? (
        <polygon points={dataPoints} style={AREA} strokeWidth="2" strokeLinejoin="round" />
      ) : (
        /* 空态：全新用户画出来只是中心一个小疙瘩 + 六个 0%，看着像图坏了。
           这里给一句话，与同一弹窗「内容领域」的「暂无数据」空态对齐 */
        <text
          x={CX}
          y={CY}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="11"
          fontFamily={FONT}
          style={HINT}
        >
          行为样本不足
        </text>
      )}
      {/* 轴外标签 + 数值 + 顶点圆点 */}
      {verts.map((v) => (
        <g key={v.role} fontFamily={FONT}>
          <text
            x={v.lx}
            y={v.ly}
            textAnchor={v.anchor}
            fontSize="11"
            fontWeight="600"
            style={LABEL}
            dominantBaseline="central"
          >
            {v.label}
          </text>
          {hasData && (
            <>
              <text
                x={v.vx}
                y={v.vy}
                textAnchor="middle"
                fontSize="9"
                style={VALUE}
                dominantBaseline="central"
              >
                {Math.round(v.score * 100)}%
              </text>
              {/* 半径恒定 3：原先只对 developer 且 score>=0.9 放大到 3.5，
                  其余五角同样满分却不变——照 demo 数据调出来的残留，去掉 */}
              <circle cx={v.px} cy={v.py} r={3} style={DOT} />
            </>
          )}
        </g>
      ))}
    </svg>
  );
}
