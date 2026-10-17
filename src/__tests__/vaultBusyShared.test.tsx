/**
 * 导入/导出的「正在跑」状态必须**跳入口共享**。
 *
 * 🔴 盯的是一个真 bug（2026-09-09）：`useNoteVaultOps` 有两个调用点
 * （知识库「⋯」溢出菜单与设置页「数据管理」那两行），而 `busy` 之前是
 * `useState`——各自一份。于是从菜单开始导入、再去设置页，那两行显示**空闲**，
 * 可以再点一次 ⇒ 两个目录扫描并发跑在同一个库上。
 * hook 自己的注释写着「跑着时两项都不给点」，而那道防护只在单个入口内成立。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { useNoteVaultOps } from "@/hooks/useNoteVaultOps";

/** 受测控的导出：手动 resolve，以便在「跑到一半」时观察两个入口。 */
let resolveExport: ((v: unknown) => void) | null = null;

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => "D:/tmp/vault"),
}));

vi.mock("@/lib/api", () => ({
  noteExportDir: vi.fn(
    () =>
      new Promise((res) => {
        resolveExport = res;
      }),
  ),
  noteImportDir: vi.fn(async () => null),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

/** 两个**独立**的调用点——模拟菜单与设置页同时挂着。 */
function Entry({ name }: { name: string }) {
  const { busy, exportDir } = useNoteVaultOps();
  return (
    <div>
      <span data-testid={`busy-${name}`}>{busy ?? "idle"}</span>
      <button onClick={() => void exportDir()}>{`导出-${name}`}</button>
    </div>
  );
}

beforeEach(() => {
  cleanup();
  resolveExport = null;
});

describe("导入导出的防重入", () => {
  it("一个入口开跑，另一个入口也得看到 busy", async () => {
    render(
      <>
        <Entry name="menu" />
        <Entry name="settings" />
      </>,
    );
    expect(screen.getByTestId("busy-menu").textContent).toBe("idle");
    expect(screen.getByTestId("busy-settings").textContent).toBe("idle");

    fireEvent.click(screen.getByText("导出-menu"));

    // 🔴 这一条就是修复前后的分水岭：以前 settings 那边仍是 idle。
    await waitFor(() => {
      expect(screen.getByTestId("busy-settings").textContent).toBe("export");
    });
    expect(screen.getByTestId("busy-menu").textContent).toBe("export");

    // 让本用例自己的导出链收尾：受控 Promise 不落地，全局 busy 就一直挂 "export"
    // 漏给下一条用例——下一条的 waitFor("export") 会被上一位的残值在首帧判真，
    // 「等永真条件」正是这样被制造出来的（慢取数注入下必红）。
    await act(async () => {
      resolveExport?.(null);
    });
    await waitFor(() => {
      expect(screen.getByTestId("busy-menu").textContent).toBe("idle");
      expect(screen.getByTestId("busy-settings").textContent).toBe("idle");
    });
  });

  it("跑完后两边一起回到 idle（全局状态必须收尾）", async () => {
    render(
      <>
        <Entry name="menu" />
        <Entry name="settings" />
      </>,
    );
    // 干净起点：上一条已把全局 busy 收摊，这里的 "export" 只可能由本条点击产生
    expect(screen.getByTestId("busy-menu").textContent).toBe("idle");

    fireEvent.click(screen.getByText("导出-menu"));
    await waitFor(() => {
      expect(screen.getByTestId("busy-menu").textContent).toBe("export");
    });

    // 🔴 先确认「本用例自己的 noteExportDir 已被调用」再 resolve：
    // resolveExport 归零后由 api mock 在调用瞬间重新赋值，
    // 它是「链路真的走到受控那一步」的内容信号；不确认就 resolve 可能拍到空气。
    await waitFor(() => {
      expect(resolveExport).not.toBeNull();
    });

    // 让那个受控 Promise 完成（返 null 走 api 层已弹错那条路）
    await act(async () => {
      resolveExport?.(null);
    });

    // 🔴 `busy` 改成全局后，不收尾的后果不再是「这个组件卡住」，
    //    而是**整个应用永久卡在导出中**，两个入口都再也点不动。
    await waitFor(() => {
      expect(screen.getByTestId("busy-menu").textContent).toBe("idle");
      expect(screen.getByTestId("busy-settings").textContent).toBe("idle");
    });
  });
});
