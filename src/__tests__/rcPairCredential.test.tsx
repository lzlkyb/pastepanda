/**
 * 跨网凭证双形态（QR + 8 位核对数）的守卫测试。
 *
 * 钉住的是一条**跨侧不变量**：出示方生成的码折出来的 8 位数，必须和输入方
 * 粘同一份码折出来的数**一模一样**。这个文件红一次，就等于「用户在两块屏幕上
 * 对不上数」——那是这套 UI 唯一的存在理由。
 *
 * 另外钉两件容易悄悄退化的事：
 *  - 位数/分组走 `formatPairCode`（4+4），不再有第二处 slice 口径；
 *  - 二维码不渲染成功时，出示屏其余部分照常可用（崩在画布上不能带走整屏）。
 *
 * jsdom 没有 2D canvas，`qrcode.toCanvas` 必然失败——这正好是上面第三条：
 * 断言 `aria-label` 的元素在、且核对数与发送按钮都还活着。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pairCodeDigest } from "@/lib/utils";
import { RcPairCreatePane } from "@/components/settings/RcPairCreatePane";
import { RcPairPastePane } from "@/components/settings/RcPairPastePane";

const CODE = "PP1-3F9A21C0DEADBEEF0123456789abcdef01234567-7K3P";

function renderCreate() {
  const toast = vi.fn();
  const onGenerate = vi.fn(async () => {});
  render(
    <RcPairCreatePane
      name="办公室台式机"
      setName={() => {}}
      created={CODE}
      expiresAt={Date.now() + 600_000}
      now={Date.now()}
      busy={false}
      myFp="3F9A·21C0"
      selfName="办公室台式机"
      toast={toast}
      onGenerate={onGenerate}
      onBack={() => {}}
      revealed
      onReveal={() => {}}
    />,
  );
  return { toast, onGenerate };
}

describe("出示屏：凭证双形态", () => {
  it("二维码 + 原文 + 8 位核对数三者同屏（手机扫 / 电脑粘都指着同一份凭证）", () => {
    renderCreate();

    // 原文可复制（电脑→电脑）
    expect(screen.getByLabelText("长期配对码")).toBeTruthy();
    // 二维码画布在（手机→电脑）。jsdom 画不出内容，元素仍然要挂在那儿
    expect(screen.getByLabelText("配对码二维码")).toBeTruthy();
    // 核对数与 utils 的口径一致，4+4
    expect(screen.getByText("2849 3116")).toBeTruthy();
  });

  it("未亮出时二维码 / 接入串 / 核对数一律不显示（照抄即全部的凭证）", () => {
    render(
      <RcPairCreatePane
        name=""
        setName={() => {}}
        created={CODE}
        expiresAt={Date.now() + 600_000}
        now={Date.now()}
        busy={false}
        myFp="3F9A·21C0"
        selfName=""
        toast={vi.fn()}
        onGenerate={vi.fn(async () => {})}
        onBack={() => {}}
        revealed={false}
        onReveal={() => {}}
      />,
    );
    // 核对数不显示
    expect(screen.queryByText("2849 3116")).toBeNull();
    // 接入串模糊且不可 tab 到（不走视觉也不走键盘选中）
    const area = screen.getByLabelText("长期配对码") as HTMLTextAreaElement;
    expect(area.className).toContain("inviteCodeMasked");
    expect(area.tabIndex).toBe(-1);
    // 复制按钮在遮罩态不可点
    expect((screen.getByRole("button", { name: "复制配对码" }) as HTMLButtonElement).disabled).toBe(true);
    // 主按钮是「出示」而不是「生成并复制」
    expect(screen.getByRole("button", { name: "出示（生成凭证）" })).toBeTruthy();
  });

  it("没有生成码时不出核对数（不给人一个能对错的空壳）", () => {
    render(
      <RcPairCreatePane
        name=""
        setName={() => {}}
        created={null}
        expiresAt={0}
        now={Date.now()}
        busy={false}
        myFp="3F9A·21C0"
        selfName=""
        toast={vi.fn()}
        onGenerate={vi.fn(async () => {})}
        onBack={() => {}}
        revealed={false}
        onReveal={() => {}}
      />,
    );
    expect(screen.queryByText("2849 3116")).toBeNull();
    expect(screen.queryByLabelText("配对码二维码")).toBeNull();
  });
});

describe("输入屏：两端核对同一个数", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("粘上出示方那份码 → 折出与出示屏完全一样的 8 位数", async () => {
    const previewInvite = vi.fn(async () => ({
      node_id: "peer-1",
      name: "办公室台式机",
      expires_at: 0,
    }));
    const pair = vi.fn(async () => true);
    const onPaired = vi.fn();
    render(
      <RcPairPastePane
        previewInvite={previewInvite as never}
        pair={pair as never}
        selfNodeId="self-1"
        toast={vi.fn()}
        onBack={() => {}}
        onPaired={onPaired}
      />,
    );

    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: CODE } });
    fireEvent.click(screen.getByRole("button", { name: "解析配对码" }));

    await waitFor(() => expect(screen.getByText("2849 3116")).toBeTruthy());
    // 与出示侧同一口径（同一函数、同一串输入）
    expect(pairCodeDigest(CODE)).toBe("28493116");
    // 指纹框仍要在：核对数不替代身份展示
    expect(screen.getByText(/将与之配对/)).toBeTruthy();
  });

  it("粘的码和出示的不是同一份 → 核对数不同（这条对数就是为了抓这个）", async () => {
    const previewInvite = vi.fn(async () => ({
      node_id: "peer-2",
      name: "别的机器",
      expires_at: 0,
    }));
    render(
      <RcPairPastePane
        previewInvite={previewInvite as never}
        pair={vi.fn(async () => true) as never}
        selfNodeId="self-1"
        toast={vi.fn()}
        onBack={() => {}}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "PP1-4d2f9c1a8b3e5d7f6a0b1c2d3e4f5a6b7c8d9e0f-XY12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "解析配对码" }));

    await waitFor(() => expect(screen.getByText(/将与之配对/)).toBeTruthy());
    expect(screen.queryByText("2849 3116")).toBeNull();
  });

  it("解析失败（粘了自己的码 / 无效码）时不显示核对数", async () => {
    const previewInvite = vi.fn(async () => { throw "配对码无效"; });
    render(
      <RcPairPastePane
        previewInvite={previewInvite as never}
        pair={vi.fn(async () => true) as never}
        selfNodeId="self-1"
        toast={vi.fn()}
        onBack={() => {}}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "PP1-junk" } });
    fireEvent.click(screen.getByRole("button", { name: "解析配对码" }));

    await waitFor(() => expect(screen.getByText("配对码无效")).toBeTruthy());
    expect(screen.queryByText("2849 3116")).toBeNull();
  });
});
