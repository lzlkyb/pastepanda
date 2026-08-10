/**
 * ProfileRadar 的几何计算（纯函数部分）。
 *
 * 为何只测几何：颜色走的是 CSS 变量，jsdom 不做层叠与对比度计算，
 * 断言“fill 字面量等于 var(--x)”只是把实现重写一遍，没有信息量；
 * 而坐标 / 对齐 / 空态判定是真正会退化的部分。
 */
import { describe, it, expect } from "vitest";
import type { RoleScore } from "@/lib/api/profile";
import {
  ROLES_ORDER,
  DEG,
  polar,
  hexPoints,
  anchorOf,
  radarScoreOf,
  hasRadarData,
  radarAreaPoints,
  radarVerts,
} from "@/components/ProfileRadar";

/** 雷达图几何常量（与组件内 CX/CY/R 一致） */
const CX = 110;
const CY = 110;
const R = 80;

const score = (role: string, s: number): RoleScore => ({ role, label: role, score: s });

describe("polar", () => {
  it("0° 在 12 点方向（正上）", () => {
    const [x, y] = polar(0, R);
    expect(x).toBeCloseTo(CX, 6);
    expect(y).toBeCloseTo(CY - R, 6);
  });

  it("90° 在 3 点方向（顺时针）", () => {
    const [x, y] = polar(90, R);
    expect(x).toBeCloseTo(CX + R, 6);
    expect(y).toBeCloseTo(CY, 6);
  });

  it("180° 在 6 点方向", () => {
    const [x, y] = polar(180, R);
    expect(x).toBeCloseTo(CX, 6);
    expect(y).toBeCloseTo(CY + R, 6);
  });

  it("半径 0 回到圆心", () => {
    expect(polar(137, 0)).toEqual([CX, CY]);
  });
});

describe("hexPoints", () => {
  it("给出 6 个顶点，且每个顶点到圆心距离等于半径", () => {
    const pts = hexPoints(R).split(" ");
    expect(pts).toHaveLength(6);
    for (const p of pts) {
      const [x, y] = p.split(",").map(Number);
      expect(Math.hypot(x - CX, y - CY)).toBeCloseTo(R, 6);
    }
  });
});

describe("anchorOf", () => {
  it("顶部/底部居中，右侧 start，左侧 end", () => {
    expect(anchorOf(0)).toBe("middle");
    expect(anchorOf(180)).toBe("middle");
    expect(anchorOf(60)).toBe("start");
    expect(anchorOf(120)).toBe("start");
    expect(anchorOf(240)).toBe("end");
    expect(anchorOf(300)).toBe("end");
  });
});

describe("radarScoreOf", () => {
  it("缺失的角色记 0", () => {
    const at = radarScoreOf([score("developer", 1)]);
    expect(at("developer")).toBe(1);
    expect(at("data")).toBe(0);
    expect(at("不存在的角色")).toBe(0);
  });
});

describe("hasRadarData", () => {
  it("空数组与全 0 都算没数据（这是空态文案的开关）", () => {
    expect(hasRadarData([])).toBe(false);
    expect(hasRadarData(ROLES_ORDER.map((r) => score(r, 0)))).toBe(false);
  });

  it("只要有一项 > 0 就算有数据", () => {
    expect(hasRadarData([score("ops", 0.01)])).toBe(true);
  });
});

describe("radarAreaPoints", () => {
  it("恒为 6 个顶点，即使入参只给了一个角色", () => {
    expect(radarAreaPoints([score("developer", 1)]).split(" ")).toHaveLength(6);
  });

  it("分数 0 也不塌陷到圆心（保留最小可见度）", () => {
    const first = radarAreaPoints([]).split(" ")[0];
    const [x, y] = first.split(",").map(Number);
    const d = Math.hypot(x - CX, y - CY);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeCloseTo(R * 0.02, 6);
  });

  it("满分顶点落在最外层网格上", () => {
    // developer 是 ROLES_ORDER[0]，对应 DEG[0] = 0°（正上）
    const first = radarAreaPoints([score("developer", 1)]).split(" ")[0];
    const [x, y] = first.split(",").map(Number);
    expect(x).toBeCloseTo(CX, 6);
    expect(y).toBeCloseTo(CY - R, 6);
  });
});

describe("radarVerts", () => {
  it("恒返回六轴，顺序与 ROLES_ORDER 一致（12 点是开发，不按分数排）", () => {
    // 故意把最高分放在 data，验证不会因此被提到 12 点
    const verts = radarVerts([score("data", 1), score("developer", 0.2)]);
    expect(verts.map((v) => v.role)).toEqual(ROLES_ORDER);
    expect(verts[0].role).toBe("developer");
    expect(verts[0].label).toBe("开发");
  });

  it("标签比最外层网格更靠外，数值在内层", () => {
    const v = radarVerts([score("developer", 1)])[0];
    expect(Math.hypot(v.lx - CX, v.ly - CY)).toBeCloseTo(R + 24, 6);
    expect(Math.hypot(v.vx - CX, v.vy - CY)).toBeCloseTo(R * 0.62, 6);
  });

  it("顶点圆点按真实分数定位（不取最小可见度）", () => {
    const v = radarVerts([score("developer", 0.5)])[0];
    expect(Math.hypot(v.px - CX, v.py - CY)).toBeCloseTo(R * 0.5, 6);
    // 未出现的角色分数 0 → 圆点落在圆心
    const zero = radarVerts([score("developer", 0.5)])[1];
    expect(zero.px).toBeCloseTo(CX, 6);
    expect(zero.py).toBeCloseTo(CY, 6);
  });

  it("六轴角度表与对齐方式逐项对应", () => {
    const verts = radarVerts([]);
    verts.forEach((v, i) => {
      expect(v.anchor).toBe(anchorOf(DEG[i]));
    });
  });
});
