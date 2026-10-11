import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

function executeRunner(keychainExit = 0) {
  const filename = path.resolve("scripts/macos-native-check.mjs");
  const source = readFileSync(filename, "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace("fileURLToPath(import.meta.url)", JSON.stringify(filename));
  const calls: { command: string; args: string[] }[] = [];
  const process = { platform: "darwin", execPath: "fixture-node", exitCode: 0 };
  const console = { log: vi.fn(), error: vi.fn() };
  runInNewContext(source, {
    process, console, path,
    mkdirSync: vi.fn(),
    mkdtempSync: () => "/fixture/native-probes",
    rmSync: vi.fn(),
    spawnSync: (command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: args.some(arg => arg.endsWith("macos-keychain-check.mjs")) ? keychainExit : 0 };
    },
  });
  return { calls, process, console };
}

it("Mac 原生 CI 实际执行钥匙串授权探针", () => {
  const { calls, process } = executeRunner();
  expect(calls.filter(call => call.command === "fixture-node" &&
    call.args.some(arg => arg.endsWith("macos-keychain-check.mjs")))).toHaveLength(1);
  expect(process.exitCode).toBe(0);
});

it("钥匙串探针失败使原生 CI 失败，不报告全部通过", () => {
  const { process, console } = executeRunner(2);
  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalled();
  expect(console.log.mock.calls.flat().some(text => String(text).includes("All fourteen"))).toBe(false);
});
