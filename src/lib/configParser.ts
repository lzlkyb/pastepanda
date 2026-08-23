/**
 * lib/configParser.ts —— 配置文本（.env / ini / 通用 key:value）的解析与回写。
 *
 * 从 `ConfigEditor.tsx` 抽出来（规则 #11：公共纯函数不留在组件里）。
 * 抽出的直接收益是可测——配置解析最容易错的地方（引号、两种分隔符、
 * section 归属、注释原样保留）都需要用例钉住，内联在组件里时一条都测不了。
 * 对照做法：`LogEditor` 复用的 `lib/logParser.ts` 一直就是这么组织的。
 *
 * **不解析、不改写的原则**：注释 / 空行 / 认不出的行一律原样保留 `raw`，
 * 回写时直接吐回。用户的配置文件不该因为「打开看了一眼」就被格式化掉。
 */

/** 一行配置的描述；数组下标与原文行号一一对应 */
export type LineDesc =
  | { type: "blank"; raw: string }
  | { type: "comment"; raw: string }
  | { type: "other"; raw: string }
  | { type: "section"; name: string; raw: string }
  | {
      type: "kv";
      section: string;
      key: string;
      value: string;
      sep: string;
      quote: string;
      /** key 前的原始缩进（ini 里嵌套缩进很常见，回写不能吞掉） */
      indent: string;
      /** key 与 value 之间的原文片段（含分隔符与两侧空格，如 `"="` / `" = "` / `": "`） */
      mid: string;
      /** value 之后的原始尾随空白 */
      trail: string;
    };

/** kv 行合法的 key 形状（与 parseConfig 的匹配口径一致；供调用方在回写前校验） */
export const KEY_PATTERN = /^[\w./-]+$/;

/**
 * 解析配置文本为行描述（index 与原文行号一一对应）。
 *
 * key 允许 `.` / `/` / `-`（`log.level`、`path/to`、`my-key` 在真实配置里都常见）。
 * 值只按**第一个**分隔符切，所以 `url=http://a:8080/x?y=1` 不会被截断。
 *
 * kv 行按 `raw` 而非 `trim()` 后的文本匹配，为的是把缩进 / 分隔符两侧空格 / 尾随空白
 * 原样留在 `indent` / `mid` / `trail` 里 —— 回写时才能一字不差地拼回去。
 */
export function parseConfig(text: string): LineDesc[] {
  const lines = text.split("\n");
  const out: LineDesc[] = [];
  let section = "";
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === "") { out.push({ type: "blank", raw }); continue; }
    if (/^[#;]/.test(trimmed)) { out.push({ type: "comment", raw }); continue; }
    const sec = trimmed.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1].trim(); out.push({ type: "section", name: section, raw }); continue; }
    // trail 的字符类带上 `\r`：文本按 "\n" 切，CRLF 的行尾会留一个 `\r` 在行末。
    // 不收进 trail 的话它会被 `.*?` 吸进 value，回写时又跟着值一起写回去（值末尾多个不可见字符）。
    const m = raw.match(/^([ \t]*)([\w./-]+)([ \t]*[:=][ \t]*)(.*?)([ \t\r]*)$/);
    if (m) {
      const [, indent, key, mid, rawValue, trail] = m;
      const sep = mid.includes("=") ? "=" : ":";
      let value = rawValue;
      let quote = "";
      const dq = value.match(/^"(.*)"$/);
      if (dq) { quote = '"'; value = dq[1]; }
      else {
        const sq = value.match(/^'(.*)'$/);
        if (sq) { quote = "'"; value = sq[1]; }
      }
      out.push({ type: "kv", section, key, value, sep, quote, indent, mid, trail });
    } else {
      out.push({ type: "other", raw });
    }
  }
  return out;
}

/**
 * 由单行描述还原为文本行（kv 行用最新 key/value 重建，缩进 / 分隔符写法 / 引号 / 尾随空白全部照原样）。
 * 非 kv 行原样返回 `raw`——注释和空行不能因为回写被改掉。
 *
 * ❗ 这里绝不能自作主张往分隔符后补空格：`KEY=value` 一旦被写成 `KEY= value`，
 *   `source .env` 在 bash 里会解析成 `KEY=""` 然后把 `value` 当命令执行，
 *   `docker --env-file` 也不 trim 值。用户的配置文件不该因为改了一个值就被格式化。
 */
export function emitLine(d: LineDesc, key: string, value: string): string {
  if (d.type !== "kv") return d.raw;
  const v = d.quote ? `${d.quote}${value}${d.quote}` : value;
  return `${d.indent}${key}${d.mid}${v}${d.trail}`;
}

/** 检测配置格式（仅用于展示徽章，不影响解析） */
export function detectFormat(text: string): string {
  if (/^\s*\[[^\]]+\]\s*$/m.test(text)) return "INI";
  if (/^[A-Z_][\w.]*\s*=\s*\S+/m.test(text)) return "ENV";
  if (/^[A-Za-z_][\w.-]*\s*:\s*\S+/m.test(text)) return "YAML/TOML";
  return "通用";
}
