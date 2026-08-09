/**
 * transforms/actionTransforms.ts —— 执行类动作（v6.0 复制即执行）。
 *
 * 与 text 类变换不同：这些动作**不产出可复制文本**，而是直接产生副作用——
 * 打开浏览器、资源管理器、邮件客户端、查询页。契约上用 `kind: "action"` 标记，
 * UI 据此只显示「执行」按钮：没有预览、没有复制/粘贴。
 *
 * **安全红线（路线图 v6.0 三条红线）**：
 * - URL 一律走后端 `open_url` 的协议白名单（http/https/mailto），
 *   不直接调 plugin-opener（后者对协议不设防，`file:`/`cmd:` 链接能打开任意程序）；
 * - **shell 命令永不自动执行**：本模块没有 shell 动作（红线③，不给开关）；
 * - 路径打开复用后端 `open_file_location`（自带存在性检查与网络路径拦截）。
 */
import { invoke } from "@tauri-apps/api/core";
import type { Transform, TransformContext, TransformResult } from "./types";

// ===== 识别正则（detect 用，全部要求"恰好单个目标"，多行内容一律不命中） =====

/** 单个 http/https URL */
const URL_RE = /^https?:\/\/\S+$/i;

/** Windows 本地路径：C:\... 或 C:/... 或 UNC \\server\share\... */
const WIN_PATH_RE = /^[A-Za-z]:[\\/][^\r\n]+$|^\\\\[^\\]+[\\/][^\r\n]+$/;

/** 单个邮箱 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** IPv4 地址（detect 阶段粗匹配，run 前再校验 0-255） */
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 域名（含子域，至少一个点；localhost 这类单 token 不算） */
const DOMAIN_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** IPv4 每段是否都在 0-255 */
function validIpv4(s: string): boolean {
  return s.split(".").every((oct) => {
    const n = Number(oct);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/** 内容必须是"恰好单个目标"：单行、非空、无前后空白差异（trim 后长度一致即无多余空白） */
function singleTarget(ctx: TransformContext): string | null {
  const t = ctx.text.trim();
  if (!t || ctx.features?.stats?.isMultiline) return null;
  // 防止 "a@b.com 和 c@d.com" 这类多目标混在一起
  if (/\s/.test(t)) return null;
  return t;
}

function makeRun(opener: (target: string) => Promise<unknown>) {
  return async (text: string): Promise<TransformResult> => {
    try {
      await opener(text.trim());
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  };
}

/** 打开浏览器（走后端协议白名单） */
const openUrl = (u: string) => invoke("open_url", { url: u });

/** 打开资源管理器定位（目录直接打开，文件 /select 选中） */
const revealPath = (p: string) => invoke("open_file_location", { path: p });

/** 用查询页打开 IP/域名（whois，知名服务） */
const openWhois = (target: string) =>
  invoke("open_url", { url: `https://whois.domaintools.com/${encodeURIComponent(target)}` });

export const actionTransforms: Transform[] = [
  {
    id: "act-open-url",
    label: "打开链接",
    description: "在默认浏览器中打开这个网址",
    icon: "globe",
    group: "web",
    kind: "action",
    detect: (ctx) => {
      const t = singleTarget(ctx);
      if (!t) return 0;
      return URL_RE.test(t) ? 0.9 : 0;
    },
    run: makeRun(openUrl),
  },
  {
    id: "act-open-path",
    label: "在资源管理器打开",
    description: "定位到这个路径（文件夹直接打开）",
    icon: "folder",
    group: "web",
    kind: "action",
    detect: (ctx) => {
      const t = singleTarget(ctx);
      if (!t) return 0;
      return WIN_PATH_RE.test(t) ? 0.85 : 0;
    },
    run: makeRun(revealPath),
  },
  {
    id: "act-mailto",
    label: "发送邮件",
    description: "用默认邮件客户端写信给这个地址",
    icon: "mail",
    group: "web",
    kind: "action",
    detect: (ctx) => {
      const t = singleTarget(ctx);
      if (!t) return 0;
      return EMAIL_RE.test(t) ? 0.8 : 0;
    },
    run: makeRun((email) => openUrl(`mailto:${email}`)),
  },
  {
    id: "act-lookup",
    label: "查询 IP / 域名",
    description: "打开 whois 页面查看归属信息",
    icon: "search",
    group: "web",
    kind: "action",
    detect: (ctx) => {
      const t = singleTarget(ctx);
      if (!t) return 0;
      // 纯数字+点 = IP 形状：必须每段 0-255 才算（999.1.1.1 不命中，
      // 而且不能让它落进下面的域名分支——否则看起来又像个"域名"）
      if (/^[\d.]+$/.test(t)) return IPV4_RE.test(t) && validIpv4(t) ? 0.75 : 0;
      return DOMAIN_RE.test(t) ? 0.7 : 0;
    },
    run: makeRun(openWhois),
  },
];
