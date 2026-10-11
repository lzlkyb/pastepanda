import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("Mac 钥匙串交互只由主动开启 MCP 触发，后台读取保持非交互", () => {
  const native = readFileSync("src-tauri/src/macos/paste.m", "utf8");
  const rust = readFileSync("src-tauri/src/macos/secret_store.rs", "utf8");
  const command = readFileSync("src-tauri/src/commands/mcp.rs", "utf8");
  expect(native).toContain("pp_mac_keychain_authorize");
  const backgroundRead = native.split("int32_t pp_mac_keychain_read")[1].split("int32_t pp_mac_keychain_create")[0];
  expect(backgroundRead).toContain("SecKeychainSetUserInteractionAllowed(false)");
  expect(backgroundRead).not.toContain("SecKeychainSetUserInteractionAllowed(true)");
  expect(rust).toContain("pub fn authorize_access");
  const toggle = command.split("pub async fn mcp_set_enabled")[1]?.split("/// 把 HTTPS")[0];
  expect(toggle).toMatch(/if enabled[\s\S]*authorize_access[\s\S]*load_or_create/);
  const bootstrap = readFileSync("src-tauri/src/lib.rs", "utf8");
  expect(bootstrap).not.toContain("authorize_access");
});
