/**
 * 守卫单测：`lib/fileDetail.ts` 的纯判断（规则 #11.1 的「收口后补守卫」）。
 *
 *  这里钉住的是从 FileDetailDialog 提出来后不变涣掉的口径：
 *  - `planOpenAllFolders`：同目录只开一次、保持列表顺序、查失败≠不存在（一并包进来）
 *  - `dirOf`：Windows 反斜杠 / POSIX 斜杠 / 裸文件名三分支
 *  - `summarizeOpenAll`：三分支文案，逐字对齐旧实现（含全失败时透出真实原因）
 *  - `openAllShouldAbort`：连续 3 次失败短路阈值
 *  - `formatSize`：0 字节是合法大小，不许显示成「未知」
 */
import { describe, it, expect } from "vitest";
import {
  dirOf,
  formatSize,
  nameOf,
  openAllShouldAbort,
  planOpenAllFolders,
  summarizeOpenAll,
  textContentType,
  isImageFile,
  isPdfFile,
  isPlayableMedia,
} from "@/lib/fileDetail";

const BS = "\\"; // Windows 路径分隔符（测试里到处用，别散着写字面量）

describe("dirOf", () => {
  it("按最后一个分隔符切，Windows 与 POSIX 都认", () => {
    expect(dirOf("C:" + BS + "Users" + BS + "a" + BS + "b.txt")).toBe("C:" + BS + "Users" + BS + "a");
    expect(dirOf("/home/a/b.txt")).toBe("/home/a");
  });

  it("裸文件名没有目录 → 空串", () => {
    expect(dirOf("b.txt")).toBe("");
  });

  it("混合分隔符取真正的最后一个", () => {
    expect(dirOf("C:" + BS + "dir/sub/file.png")).toBe("C:" + BS + "dir/sub");
  });
});

describe("nameOf", () => {
  it("取末段文件名", () => {
    expect(nameOf("C:" + BS + "a" + BS + "b.txt")).toBe("b.txt");
    expect(nameOf("/a/b/c.png")).toBe("c.png");
  });
});

describe("planOpenAllFolders", () => {
  // 旧实现的真实口径：infoMap 里存在 **或** 查询失败（failedPaths）都算可打开。
  // 后者不是「确认不存在」——把查询失败排除掉，会连试都不让用户试（U3.5）。
  const isOpenable = (p: string) => p.startsWith("ok") || p.startsWith("fail");

  it("同一目录只开一次（多文件同目录 = 一个资源管理器窗口）", () => {
    const paths = ["C:" + BS + "d" + BS + "a.txt", "C:" + BS + "d" + BS + "b.txt", "C:" + BS + "d" + BS + "c.txt"];
    expect(planOpenAllFolders(paths, () => true).paths).toEqual(["C:" + BS + "d" + BS + "a.txt"]);
  });

  it("保持 paths 顺序（用户列表先后 = 窗口弹出先后）", () => {
    const paths = [
      "C:" + BS + "z" + BS + "1.txt",
      "C:" + BS + "a" + BS + "2.txt",
      "C:" + BS + "m" + BS + "3.txt",
    ];
    expect(planOpenAllFolders(paths, () => true).paths).toEqual(paths);
  });

  it("不可打开的路径被跳过，其目录不占位", () => {
    const paths = ["okA" + BS + "1.txt", "gone" + BS + "2.txt", "okB" + BS + "3.txt"];
    expect(planOpenAllFolders(paths, isOpenable).paths).toEqual(["okA" + BS + "1.txt", "okB" + BS + "3.txt"]);
  });

  it("查询失败的路径仍算可打开（没查到 ≠ 不存在）", () => {
    const plan = planOpenAllFolders(["failQ" + BS + "1.txt"], isOpenable);
    expect(plan.paths).toEqual(["failQ" + BS + "1.txt"]);
    expect(plan.empty).toBe(false);
  });

  it("全不可开 → empty（调用方提示「没有可打开的文件」）", () => {
    expect(planOpenAllFolders(["gone" + BS + "1.txt", "gone" + BS + "2.txt"], isOpenable).empty).toBe(true);
    expect(planOpenAllFolders([], isOpenable).empty).toBe(true);
  });

  it("同目录里既有可开也有不可开的：目录仍只留第一个", () => {
    const paths = ["C:" + BS + "d" + BS + "gone.txt", "C:" + BS + "d" + BS + "ok.txt"];
    expect(planOpenAllFolders(paths, (p) => p.includes("ok")).paths).toEqual(["C:" + BS + "d" + BS + "ok.txt"]);
  });

  it("守护：兄弟目录名前缀碰撞不抢代表（C:\\data 不能命中 C:\\data2）", () => {
    // 钉的是抽取时踩到的坑：调用方若拿目录名 startsWith 反查路径，
    // "C:\\data2\\b.txt" 排前面就抢走 "C:\\data" 的代表位——
    // 结果 data 目录永远不开、data2 开两次。规划阶段直接产出代表路径后无事。
    const paths = ["C:" + BS + "data2" + BS + "b.txt", "C:" + BS + "data" + BS + "a.txt"];
    expect(planOpenAllFolders(paths, () => true).paths).toEqual(paths);
  });

  it("守护：裸文件名各自成目标，不塌成一个", () => {
    // 没有分隔符时目录算 ""。若拿 "" 当 key 去重，只会开第一个、其余静默丢掉。
    expect(planOpenAllFolders(["a.txt", "b.txt"], () => true).paths).toEqual(["a.txt", "b.txt"]);
  });
});

describe("openAllShouldAbort", () => {
  it("连续 3 次失败才短路，前两次继续", () => {
    expect(openAllShouldAbort(1)).toBe(false);
    expect(openAllShouldAbort(2)).toBe(false);
    expect(openAllShouldAbort(3)).toBe(true);
  });
});

describe("summarizeOpenAll", () => {
  it("全成功 → success", () => {
    expect(summarizeOpenAll(3, 0, false)).toEqual({ message: "已打开 3 个文件夹", level: "success" });
  });

  it("全失败 → error（即使有目录被跳过也不能说成半成功）", () => {
    expect(summarizeOpenAll(0, 2, false)).toEqual({ message: "无法打开文件夹", level: "error" });
  });

  it("全失败时透出真实原因（文件没了 vs 权限不够不是一回事）", () => {
    expect(summarizeOpenAll(0, 2, false, "系统找不到指定的路径")).toEqual({
      message: "系统找不到指定的路径",
      level: "error",
    });
  });

  it("没给原因文本时回落兜底文案", () => {
    expect(summarizeOpenAll(0, 1, false, "").message).toBe("无法打开文件夹");
    expect(summarizeOpenAll(0, 1, false).message).toBe("无法打开文件夹");
  });

  it("部分失败 → info", () => {
    expect(summarizeOpenAll(2, 1, false).level).toBe("info");
    expect(summarizeOpenAll(2, 1, false).message).toBe("已打开 2 个文件夹，1 个失败");
  });

  it("短路中止时把「连续失败已中止」说出口", () => {
    expect(summarizeOpenAll(2, 3, true).message).toContain("（连续失败已中止）");
  });
});

describe("formatSize", () => {
  it("0 字节是合法大小，不是「未知」", () => {
    expect(formatSize(0)).not.toBe("未知");
    expect(formatSize(1024)).toBe("1.0 KB");
  });
});

describe("扩展名族", () => {
  it("图片族", () => {
    expect(isImageFile("a.png")).toBe(true);
    expect(isImageFile("a.PNG")).toBe(true);
    expect(isImageFile("a.pdf")).toBe(false);
  });

  it("PDF 独立分支", () => {
    expect(isPdfFile("a.pdf")).toBe(true);
    expect(isImageFile("a.pdf")).toBe(false);
  });

  it("可播放媒体 = 视频 ∪ 音频（只列 WebView 能解的容器）", () => {
    expect(isPlayableMedia("a.mp4")).toBe(true);
    expect(isPlayableMedia("a.flac")).toBe(true);
    expect(isPlayableMedia("a.mkv")).toBe(false);
    expect(isPlayableMedia("a.txt")).toBe(false);
  });

  it("textContentType：未知扩展名回落 text", () => {
    expect(textContentType("md")).toBe("markdown");
    expect(textContentType("rs")).toBe("code");
    expect(textContentType("xyz")).toBe("text");
  });
});
