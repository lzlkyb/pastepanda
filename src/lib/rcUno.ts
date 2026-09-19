/**
 * 无人值守接入码（Q2 方案 B）——前端侧的解析与格式化。
 *
 * 两种可粘贴形态：
 * - 展示码 `XXXX-XXXX`（电话可读）：只够授权，**定位不了机器**——
 *   只在同一局域网（附近设备列表里能看见对方）时可用；
 * - 完整接入串 `PPU-XXXX-XXXX-<node_id>`：跨网传递的正身，
 *   微信/剪贴板复制粘贴，node_id 必须随码一起走。
 *
 * 后端（`rc/uno.rs`）做真正的校验（归一化 + 摘要比对）；这里只做
 * 「把用户粘进来的一坨字拆成结构」和基本形状检查，错误信息给得能指导动作。
 */

export interface ParsedUno {
  /** 8 位展示码（大写、无分隔符）。 */
  code: string;
  /** 对端设备号。完整接入串才有；裸码没有（要靠局域网发现补上）。 */
  nodeId?: string;
}

/**
 * 从粘贴内容里抠出接入码（与可选设备号）。
 *
 * 🔴 **不能把整串大写化**：node_id 是 base32 小写、大小写敏感，
 * 只有 `PPU` 前缀与码的部分不区分大小写。宽容规则与邀请码一致：
 * 用户大概率连「接入码：」一起粘进来，前后杂质直接忽略。
 */
export function parseUnoInput(raw: string): ParsedUno | null {
  const s = raw.trim();
  if (!s) return null;
  // 完整接入串：PPU-XXXX-XXXX-<node_id>（分隔横杠可有可无，前后允许杂质）
  const full = /PPU[- ]?([0-9A-Za-z]{4})[- ]?([0-9A-Za-z]{4})[- ](\S+)/i.exec(s);
  if (full) {
    return { code: (full[1] + full[2]).toUpperCase(), nodeId: full[3] };
  }
  // 裸码：8 位（可有横杠/空格分组）。先抽掉「接入码」之类的引导词再试。
  const compact = s.replace(/^.*?(接入码|码)[:：]?\s*/i, "").trim();
  const bare = /^([0-9A-Za-z]{4})[- ]?([0-9A-Za-z]{4})$/.exec(compact);
  if (bare) return { code: (bare[1] + bare[2]).toUpperCase() };
  return null;
}

/** 码的形状检查（去分隔符后 8 位、字符集合规）。真正的校验在收到码的那台机器。 */
export function unoCodeShapeOk(code: string): boolean {
  return /^[0-9A-HJ-NP-TV-Z]{8}$/.test(code.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1"));
}
