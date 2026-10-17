import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(resolve(process.cwd(), name), "utf8");
const session = read("src-tauri/src/macos/rec_session.rs");
const native = read("src-tauri/src/macos/recording.m");
const trim = read("src-tauri/src/macos/rec_trim.rs");

function body(source: string, signature: string) {
  const start = source.indexOf(signature);
  expect(start, `Missing ${signature}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 1;
  let end = open + 1;
  for (; depth > 0 && end < source.length; end++) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  return source.slice(open + 1, end - 1);
}

describe("Mac recording adapters retain shared backend contracts", () => {
  it("checks existing permissions and devices without prompting or starting capture", () => {
    const check = body(native, "void pp_rec_audio_check(");
    expect(check).toContain("if(@available(macOS 13.0,*))");
    expect(check).toContain("CGPreflightScreenCaptureAccess()");
    expect(check).toContain("authorizationStatusForMediaType:AVMediaTypeAudio");
    expect(check).toContain("defaultDeviceWithMediaType:AVMediaTypeAudio");
    expect(check).toContain("NSMicrophoneUsageDescription");
    expect(check).not.toMatch(/requestAccess|requestScreenCapture|startRunning|startCapture|openURL/);
    expect(body(session, "pub fn check_audio(")).toContain("pp_rec_audio_check");
  });

  it("retains task cancellation until native export returns and before atomic publication", () => {
    expect(trim).toContain('#[path = "../rec/trim_job.rs"]');
    expect(trim).toContain("pub use trim_job::{cancel as cancel_job, start as start_job, status as job_status, TrimJob}");
    const work = body(trim, "pub fn trim_with_job(");
    const nativeExport = work.indexOf("pp_trim_export(");
    const lastCancel = work.lastIndexOf("check_cancelled()");
    expect(nativeExport).toBeGreaterThan(0);
    expect(lastCancel).toBeGreaterThan(nativeExport);
    expect(work.indexOf("pending.commit()")).toBeGreaterThan(lastCancel);
    expect(work).not.toContain("job.progress(");
  });

  it("persists aggregated warnings even when event capture is disabled", () => {
    const finish = body(session, 'extern "C" fn completed(');
    expect(finish).toContain("a.warnings");
    expect(finish).toContain("a.sidecar.warning()");
    expect(finish).toContain("a.sidecar.write_result(");
    expect(finish).toContain("note.as_deref()");
    expect(finish).not.toContain('"duration_ms"');
    expect(finish).toContain('"durationMs"');
  });
});
