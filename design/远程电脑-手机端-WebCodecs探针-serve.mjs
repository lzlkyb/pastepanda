#!/usr/bin/env node
/**
 * 探针 B 真机服务（手机端规划 P0.5 · 2026-09-29）
 *
 * 用途：把《远程电脑-手机端-WebCodecs探针页-2026-09-29.html》
 * 用 https 提供给同一 WiFi 下的手机浏览器 / Android WebView 打开。
 * （WebCodecs 要求安全上下文：https 或 file://；局域网 http 打不开 API。）
 *
 * 用法：
 *   node design/远程电脑-手机端-WebCodecs探针-serve.mjs
 * 首次运行若缺证书，按脚本提示生成一次（需 Git Bash 自带的 openssl）：
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
 *     -keyout design/probe-cert/key.pem -out design/probe-cert/cert.pem -subj "/CN=pastepanda-probe"
 * 手机浏览器打开脚本打印的 https 地址，自签证书点「高级 → 继续访问」即可。
 * 也可以零依赖：把 HTML 单文件直接发到手机（微信/QQ），用 Chrome 打开 file:// 同样是安全上下文。
 */
import https from "node:https";
import http from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "远程电脑-手机端-WebCodecs探针页-2026-09-29.html");
const certDir = join(here, "probe-cert");
const keyPath = join(certDir, "key.pem");
const certPath = join(certDir, "cert.pem");

if (!existsSync(htmlPath)) {
  console.error(`✗ 找不到探针页：${htmlPath}`);
  process.exit(1);
}
const html = readFileSync(htmlPath);

const lanIps = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && n.family === "IPv4" && !n.internal)
  .map((n) => n.address);

if (existsSync(keyPath) && existsSync(certPath)) {
  const server = https.createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    },
  );
  server.listen(8443, () => {
    console.log("探针页已就绪（https，自签证书，手机点「高级→继续访问」）：");
    for (const ip of lanIps) console.log(`  https://${ip}:8443/`);
  });
} else {
  const server = http.createServer((req, res) => {
    // http 降级仅用于桌面本机（localhost 是安全上下文）；真机必须走 https。
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html.replace(
      "<h1>",
      '<div style="background:#7f1d1d;color:#fecaca;padding:8px 14px;font-size:12px">⚠ 当前是 http 非安全上下文，真机上 WebCodecs 不可用。请生成证书后用 https 访问，或把 HTML 文件直接拷到手机用 Chrome 打开。</div><h1>',
    ));
  });
  server.listen(8080, () => {
    console.log("http 降级模式（仅桌面本机验证页面逻辑）：");
    console.log("  http://localhost:8080/");
    console.log("\n真机需要 https。生成证书后重新运行本脚本：");
    console.log(`  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \\`);
    console.log(`    -keyout design/probe-cert/key.pem -out design/probe-cert/cert.pem -subj "/CN=pastepanda-probe"`);
    console.log("\n或零依赖路径：把探针 HTML 单文件直接发到手机，用 Chrome 打开（file:// 即安全上下文）。");
    console.log("同网段地址备查：");
    for (const ip of lanIps) console.log(`  ${ip}`);
  });
}
