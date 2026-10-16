import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "../../src-tauri/src/rc", file), "utf8");

describe("MTU 探测的会话生命周期接线", () => {
  it("推流入口将探测与会话放在同一取消域", () => {
    const entry = read("service/inbound_accept.rs").split("pub(in crate::rc) async fn spawn_inbound_video")[1];
    expect(entry).toContain("pmtud::run_during(");
    expect(entry).not.toContain("async_runtime::spawn");
    expect(read("pmtud.rs")).toContain("tokio::select!");
  });

  it("同一设备重连后，旧推流循环按会话编号退出", () => {
    expect(read("inbound/video_run.rs")).toMatch(/loop \{\s*if !self\.svc\.session_id_is\(&self\.my_id\)/);
  });

  it("片宽和回显属于会话实例，旧任务不能读写新会话", () => {
    expect(read("stream_cfg.rs")).not.toContain("static VD_FRAG");
    expect(read("pmtud.rs")).not.toContain("static ACK_SEEN");
    expect(read("inbound.rs")).toContain("Arc<super::pmtud::ProbeState>");
    expect(read("inbound_tasks.rs")).toContain("probe.note_ack(nonce)");
    expect(read("inbound/video.rs")).toContain("self.probe.frag()");
  });
});
