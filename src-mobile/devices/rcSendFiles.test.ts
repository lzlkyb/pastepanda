/**
 * 手机端分块上载的守卫测试 —— 钉住「错了也看不出来」的三件事：
 *
 * ① 分块必须按序、偏移正确、最后一块带 last=1——后端按偏移拼装，
 *    乱序/漏块的表现是电脑收到的文件悄悄损坏（协议层有长度校验，但
 *    「内容错位且总长恰好对」的错法连它都拦不住，只有顺序对才安全）；
 * ② 元数据走 header 且文件名 encodeURIComponent——中文文件名不编码
 *    会被 HTTP header 层直接拒（非 ASCII）；
 * ③ 单文件失败不吞掉整批——返回逐个结果，调用方才知道谁没走成。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SEND_CHUNK_BYTES, sendFilesToPeer, type SendFileLike } from "./rcSendFiles";

vi.mock("@tauri-apps/api/core", async () => await import("@/__mocks__/@tauri-apps-api-core"));

const invokeMock = vi.mocked(invoke);

/** 内存里的假 File：slice 按区间给 Blob（Node 18+ 的 Blob 自带 arrayBuffer）。 */
function fakeFile(name: string, bytes: Uint8Array): SendFileLike {
  return {
    name,
    size: bytes.length,
    slice(start, end) {
      return new Blob([bytes.slice(start, end)]);
    },
  };
}

/** 取第 n 次 invoke 的调用参数。 */
function callOf(n: number) {
  const call = invokeMock.mock.calls[n];
  if (!call) throw new Error(`没有第 ${n} 次 invoke`);
  const [cmd, body, options] = call as [string, ArrayBuffer, { headers: Record<string, string> }];
  return { cmd, body: new Uint8Array(body), headers: options.headers };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe("分块上载", () => {
  it("小文件单块直达：body 原样、header 元数据齐全、last=1", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const results = await sendFilesToPeer("pc-1", [fakeFile("报告.pdf", data)]);

    expect(results).toEqual([{ name: "报告.pdf", ok: true, err: "" }]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const { cmd, body, headers } = callOf(0);
    expect(cmd).toBe("rc_file_send_blob");
    expect(Array.from(body)).toEqual([1, 2, 3, 4, 5]);
    expect(headers["x-pp-peer"]).toBe("pc-1");
    expect(headers["x-pp-total"]).toBe("5");
    expect(headers["x-pp-offset"]).toBe("0");
    expect(headers["x-pp-last"]).toBe("1");
    expect(headers["x-pp-id"]).toMatch(/^[\w-]+$/);
    // 中文名必须编码过（header 只认 ASCII）
    expect(headers["x-pp-name"]).toBe(encodeURIComponent("报告.pdf"));
  });

  // 4MB+ 逐字节填充 + 拼回比对在满负载并行跑（vitest 全量套件）时会超 5s
  // 默认上限——单跑 3.5s 通过。给这个用例单独放宽，flake 不改被测逻辑。
  it("大文件按 4MB 分块：偏移递增、只有最后一块 last=1、内容拼回原样", async () => {
    const total = SEND_CHUNK_BYTES + 3;
    const data = new Uint8Array(total);
    for (let i = 0; i < total; i++) data[i] = i % 251;
    const results = await sendFilesToPeer("pc-1", [fakeFile("big.bin", data)]);

    expect(results[0].ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    const first = callOf(0);
    const second = callOf(1);
    expect(first.headers["x-pp-offset"]).toBe("0");
    expect(first.headers["x-pp-last"]).toBe("0");
    expect(first.body.length).toBe(SEND_CHUNK_BYTES);
    expect(second.headers["x-pp-offset"]).toBe(String(SEND_CHUNK_BYTES));
    expect(second.headers["x-pp-last"]).toBe("1");
    expect(second.body.length).toBe(3);
    // 两次调用的 upload id 必须一致——后端按它落同一个暂存文件
    expect(second.headers["x-pp-id"]).toBe(first.headers["x-pp-id"]);

    const joined = new Uint8Array(total);
    joined.set(first.body, 0);
    joined.set(second.body, SEND_CHUNK_BYTES);
    expect(Array.from(joined)).toEqual(Array.from(data));
  }, 20000);

  it("空文件也发一块（last=1，后端补齐校验放行空文件）", async () => {
    await sendFilesToPeer("pc-1", [fakeFile("空.txt", new Uint8Array(0))]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(callOf(0).headers["x-pp-last"]).toBe("1");
    expect(callOf(0).body.length).toBe(0);
  });

  it("批量串行：第二个文件失败不拦第三个，结果逐个可查", async () => {
    invokeMock.mockImplementation(async (cmd, _body, options) => {
      if (cmd === "rc_file_send_blob" && (options?.headers as Record<string, string>)["x-pp-name"] === "b.txt") throw new Error("IPC 炸了");
    });
    const files = [
      fakeFile("a.txt", new Uint8Array([1])),
      fakeFile("b.txt", new Uint8Array([2])),
      fakeFile("c.txt", new Uint8Array([3])),
    ];
    const results = await sendFilesToPeer("pc-1", files);

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "rc_file_send_blob")).toHaveLength(3);
    expect(invokeMock).toHaveBeenCalledWith("rc_file_send_blob_abort", expect.objectContaining({ name: "b.txt" }));
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1].err).toContain("IPC 炸了");
  });

  it("进度回调随块推进", async () => {
    const progress = vi.fn();
    const total = SEND_CHUNK_BYTES + 1;
    await sendFilesToPeer("pc-1", [fakeFile("big.bin", new Uint8Array(total))], progress);
    expect(progress).toHaveBeenNthCalledWith(1, "big.bin", SEND_CHUNK_BYTES, total, 0);
    expect(progress).toHaveBeenNthCalledWith(2, "big.bin", total, total, 0);
  });
});

describe("取消准备的提交边界", () => {
  it("读取过程中取消，不写入后台也不开始下一文件", async () => {
    const controller = new AbortController();
    let finish!: (bytes: ArrayBuffer) => void;
    const read = new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
    const file = { name: "a.bin", size: 2, slice: vi.fn(() => ({ arrayBuffer: () => read } as Blob)) };
    const next = fakeFile("b.bin", new Uint8Array([2]));
    const result = sendFilesToPeer("pc", [file, next], undefined, controller.signal);
    controller.abort();
    finish(new ArrayBuffer(2));
    expect((await result).every((item) => item.canceled)).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });
  it("写入过程中取消，等待当前块完成后清理，后续块和文件均不提交", async () => {
    const controller = new AbortController();
    let finish!: () => void;
    const current = new Promise<void>((resolve) => { finish = resolve; });
    invokeMock.mockImplementationOnce(() => current);
    const pending = sendFilesToPeer("pc", [fakeFile("a.bin", new Uint8Array(SEND_CHUNK_BYTES + 1)), fakeFile("b.bin", new Uint8Array([2]))], undefined, controller.signal);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    finish();
    const results = await pending;
    expect(results.every((item) => item.canceled)).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[1][0]).toBe("rc_file_send_blob_abort");
  });
  it("最后一块已经受理时保留传输源，只停止下一文件", async () => {
    const controller = new AbortController();
    let finish!: () => void;
    invokeMock.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = sendFilesToPeer("pc", [fakeFile("a.bin", new Uint8Array([1])), fakeFile("b.bin", new Uint8Array([2]))], undefined, controller.signal);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    controller.abort(); finish();
    const results = await pending;
    expect(results[0].ok).toBe(true);
    expect(results[1].canceled).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
