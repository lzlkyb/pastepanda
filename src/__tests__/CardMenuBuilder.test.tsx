/**
 * 右键菜单**构建器**的结构性测试（createCardMenuItems / transformEntries / getPrimaryAction）。
 *
 * 这一层原先零覆盖：菜单里出现哪些项、按什么顺序、哪些按类型隐藏，全靠人工点开看。
 * 所以「主操作和子菜单里同一个动作重复出现」这种问题能长期存在而没人发现。
 *
 * 纯函数，不需要渲染，也不需要 mock。
 */
import { describe, it, expect, vi } from "vitest";
import { createCardMenuItems, type MenuItem } from "@/components/ContextMenu";
import type { RegexRule } from "@/lib/regexRules";

type Opts = Parameters<typeof createCardMenuItems>[0];

/** 四个必填回调的空实现 */
const REQUIRED: Opts = {
  onCopy: () => {},
  onPaste: () => {},
  onPin: () => {},
  onDelete: () => {},
};

const build = (over: Partial<Opts> = {}): MenuItem[] =>
  createCardMenuItems({ ...REQUIRED, ...over });

/** 顶层标签 */
const labels = (items: MenuItem[]) => items.map((i) => i.label);

/** 某个子菜单的子项标签 */
const subLabels = (items: MenuItem[], parent: string) =>
  (items.find((i) => i.label === parent)?.children ?? []).map((c) => c.label);

/** 点一下某个子菜单项，返回它触发的变换 id */
function transformOf(items: MenuItem[], parent: string, label: string, spy: ReturnType<typeof vi.fn>) {
  spy.mockClear();
  items.find((i) => i.label === parent)?.children?.find((c) => c.label === label)?.onClick?.();
  return spy.mock.calls[0]?.[0] as string | undefined;
}

const RULES: RegexRule[] = [
  { id: "p1", name: "去除空行", pattern: "a", replacement: "", flags: "g", enabled: true, preset: true, sort_order: 0 },
  { id: "c1", name: "我的规则", pattern: "b", replacement: "", flags: "g", enabled: true, preset: false, sort_order: 1 },
];

describe("顶层结构与顺序", () => {
  it("核心剪贴板操作一直都有，删除永远在最后且是危险项", () => {
    const items = build();
    expect(labels(items)).toContain("复制到剪贴板");
    expect(labels(items)).toContain("粘贴到前台");
    const last = items[items.length - 1];
    expect(last.label).toBe("删除");
    expect(last.danger).toBe(true);
  });

  it("按「主操作 → 复制/粘贴 → 粘贴并变换 → 正则替换 → 更多操作 → 删除」排列", () => {
    const l = labels(
      build({
        itemType: "text",
        itemSubType: "link",
        hasUrl: true,
        onOpenUrl: () => {},
        onPasteTransform: () => {},
        onRegexPreview: () => {},
        regexRules: RULES,
        onEditTags: () => {},
      }),
    );
    const at = (s: string) => l.indexOf(s);
    expect(at("在浏览器中打开")).toBe(0); // 主操作置顶
    expect(at("复制到剪贴板")).toBeLessThan(at("粘贴并变换"));
    expect(at("粘贴并变换")).toBeLessThan(at("正则替换"));
    expect(at("正则替换")).toBeLessThan(at("更多操作"));
    expect(at("更多操作")).toBeLessThan(at("删除"));
  });

  it("什么可选回调都不给时，只剩复制/粘贴/置顶/删除，不出现空子菜单", () => {
    const items = build();
    expect(labels(items)).not.toContain("粘贴并变换");
    expect(labels(items)).not.toContain("正则替换");
    // 置顶始终在「更多操作」里
    expect(subLabels(items, "更多操作")).toContain("置顶");
  });
});

describe("类型主操作的优先级", () => {
  const primaryOf = (over: Partial<Opts>) => {
    const items = build(over);
    return items[0].primary ? items[0].label : null;
  };

  it("图片 → 粘贴为 Markdown 图片", () => {
    expect(primaryOf({ itemType: "image", onPasteTransform: () => {} })).toBe("粘贴为 Markdown 图片");
  });

  it("能定位文件 → 在资源管理器中显示（优先于链接）", () => {
    expect(primaryOf({ onRevealFile: () => {}, hasUrl: true, onOpenUrl: () => {} })).toBe("在资源管理器中显示");
  });

  it("链接 → 在浏览器中打开", () => {
    expect(primaryOf({ hasUrl: true, onOpenUrl: () => {} })).toBe("在浏览器中打开");
  });

  it("JSON → 变换为…", () => {
    expect(primaryOf({ itemType: "text", itemSubType: "json", onOpenHub: () => {} })).toBe("变换为…");
  });

  it("颜色 → 复制为 HEX", () => {
    expect(primaryOf({ itemType: "text", itemSubType: "color", onPasteTransform: () => {} })).toBe("复制为 HEX");
  });

  it("普通文本 → 编辑内容，且文案随子类型变化", () => {
    expect(primaryOf({ itemType: "text", onEdit: () => {} })).toBe("编辑内容");
    expect(primaryOf({ itemType: "text", itemSubType: "markdown", onEdit: () => {} })).toBe("编辑 Markdown");
    expect(primaryOf({ itemType: "text", itemSubType: "shell", onEdit: () => {} })).toBe("编辑代码");
  });

  it("什么都不满足时没有主操作", () => {
    expect(build()[0].primary).toBeUndefined();
  });
});

describe("主操作不和别处重复（同一个动作不该在菜单里出现两次）", () => {
  it("图片：「粘贴为 Markdown 图片」只作为主操作出现，不在粘贴并变换里再来一遍", () => {
    const items = build({ itemType: "image", onPasteTransform: () => {} });
    expect(items[0].label).toBe("粘贴为 Markdown 图片");
    expect(subLabels(items, "粘贴并变换")).not.toContain("粘贴为 Markdown 图片");
    // 同类的另一项仍在
    expect(subLabels(items, "粘贴并变换")).toContain("粘贴为 Base64");
  });

  it("颜色：「复制为 HEX」只出现一次，RGB / HSL 不受影响", () => {
    const items = build({ itemType: "text", itemSubType: "color", onPasteTransform: () => {} });
    expect(items[0].label).toBe("复制为 HEX");
    const sub = subLabels(items, "粘贴并变换");
    expect(sub).not.toContain("复制为 HEX");
    expect(sub).toEqual(expect.arrayContaining(["复制为 RGB", "复制为 HSL"]));
  });

  it("主操作是「在资源管理器中显示」时，类型工具里不再重复它", () => {
    const l = labels(build({ onRevealFile: () => {} }));
    expect(l.filter((x) => x === "在资源管理器中显示")).toHaveLength(1);
  });

  it("主操作是「在浏览器中打开」时，类型工具里不再重复它", () => {
    const l = labels(build({ hasUrl: true, onOpenUrl: () => {} }));
    expect(l.filter((x) => x === "在浏览器中打开")).toHaveLength(1);
  });

  it("主操作是编辑时，类型工具里不再重复编辑入口", () => {
    const l = labels(build({ itemType: "text", onEdit: () => {} }));
    expect(l.filter((x) => x === "编辑内容")).toHaveLength(1);
  });

  it("主操作不是编辑（图片）时，编辑入口仍作为次级工具出现", () => {
    const l = labels(build({ itemType: "image", onPasteTransform: () => {}, onEdit: () => {} }));
    expect(l).toContain("编辑内容");
  });
});

describe("快捷变换按子类型给不同的项", () => {
  const t = vi.fn();
  const sub = (itemType: string, itemSubType?: string) =>
    subLabels(build({ itemType, itemSubType, onPasteTransform: t }), "粘贴并变换");

  it("链接", () => {
    expect(sub("text", "link")).toEqual(["粘贴为 Markdown 链接", "粘贴为纯链接文本"]);
  });
  it("邮箱", () => {
    expect(sub("text", "email")).toEqual(["粘贴为 mailto 链接"]);
  });
  it("代码类子类型", () => {
    expect(sub("text", "shell")).toEqual(["粘贴为代码块", "粘贴为单行"]);
  });
  it("手机号", () => {
    expect(sub("text", "phone")).toEqual(["粘贴为 tel 链接", "粘贴为 +86 格式"]);
  });
  it("路径", () => {
    expect(sub("text", "file_path")).toEqual(["粘贴为反斜杠路径", "粘贴为正斜杠路径", "粘贴为文件名"]);
  });
  it("Markdown", () => {
    expect(sub("text", "markdown")).toEqual(["粘贴为代码块", "粘贴为 Markdown 链接"]);
  });
  it("普通文本", () => {
    expect(sub("text", undefined)).toEqual(["粘贴为 Markdown 链接"]);
  });
  it("文件条目", () => {
    expect(sub("file")).toEqual([
      "粘贴为文件名",
      "粘贴为目录路径",
      "粘贴为反斜杠路径",
      "粘贴为正斜杠路径",
      "粘贴为文件列表",
    ]);
  });
  it("菜单项确实带着对应的变换 id", () => {
    const items = build({ itemType: "text", itemSubType: "phone", onPasteTransform: t });
    expect(transformOf(items, "粘贴并变换", "粘贴为 tel 链接", t)).toBe("tel");
    expect(transformOf(items, "粘贴并变换", "粘贴为 +86 格式", t)).toBe("phone_cn");
  });
  it("「更多变换…」只在 text 且给了枢纽入口时出现", () => {
    expect(subLabels(build({ itemType: "text", onPasteTransform: t, onOpenHub: () => {} }), "粘贴并变换"))
      .toContain("更多变换…");
    expect(subLabels(build({ itemType: "file", onPasteTransform: t, onOpenHub: () => {} }), "粘贴并变换"))
      .not.toContain("更多变换…");
  });
});

describe("正则替换子菜单", () => {
  it("列出传入的启用规则 + 管理入口", () => {
    const items = build({ itemType: "text", onRegexPreview: () => {}, regexRules: RULES, onManageRegexRules: () => {} });
    expect(subLabels(items, "正则替换")).toEqual(["去除空行", "我的规则", "管理正则规则…"]);
  });

  it("一条规则都没有时，仍保留管理入口（否则用户没地方去加规则）", () => {
    const items = build({ itemType: "text", onRegexPreview: () => {}, regexRules: [], onManageRegexRules: () => {} });
    expect(subLabels(items, "正则替换")).toEqual(["管理正则规则…"]);
  });

  it("点规则项时带上规则 id", () => {
    const spy = vi.fn();
    const items = build({ itemType: "text", onRegexPreview: spy, regexRules: RULES });
    items.find((i) => i.label === "正则替换")?.children?.[1].onClick?.();
    expect(spy).toHaveBeenCalledWith("c1");
  });

  it("非文本条目不显示正则替换", () => {
    expect(labels(build({ itemType: "image", onRegexPreview: () => {}, regexRules: RULES })))
      .not.toContain("正则替换");
  });
});

describe("更多操作子菜单", () => {
  it("收纳标签 / 分组 / 置顶 / 片段库", () => {
    const items = build({ onEditTags: () => {}, onMoveToGroup: () => {}, onAddSnippet: () => {} });
    expect(subLabels(items, "更多操作")).toEqual(["编辑标签", "移动到分组", "置顶", "添加到片段库"]);
  });

  it("已置顶时文案变成取消置顶", () => {
    expect(subLabels(build({ pinned: true }), "更多操作")).toContain("取消置顶");
  });

  it("有自动标签时才出现确认 / 移除自动标签", () => {
    const withAuto = build({ hasAutoTags: true, onConfirmAutoTags: () => {}, onRemoveAutoTags: () => {} });
    expect(subLabels(withAuto, "更多操作")).toEqual(expect.arrayContaining(["确认自动标签", "移除自动标签"]));
    const without = build({ onConfirmAutoTags: () => {}, onRemoveAutoTags: () => {} });
    expect(subLabels(without, "更多操作")).not.toContain("确认自动标签");
  });
});

describe("类型工具", () => {
  it("图片有 OCR 文本时给「复制识别文字」，且排在类型工具首位", () => {
    const items = build({ itemType: "image", onCopyOcr: () => {}, onPasteTransform: () => {} });
    expect(labels(items)).toContain("复制识别文字");
  });

  it("没有 OCR 回调就不给这一项", () => {
    expect(labels(build({ itemType: "image", onPasteTransform: () => {} }))).not.toContain("复制识别文字");
  });

  it("能用默认应用打开时给对应入口", () => {
    expect(labels(build({ onOpenFile: () => {} }))).toContain("用默认应用打开");
  });

  it("canQrCode 才给二维码", () => {
    expect(labels(build({ canQrCode: true, onQrCode: () => {} }))).toContain("生成二维码");
    expect(labels(build({ onQrCode: () => {} }))).not.toContain("生成二维码");
  });
});

describe("转为笔记（知识库 A 阶段）", () => {
  it("不传 onConvertToNote 就根本没这一项（file 卡片走这条，而不是先显示再报错）", () => {
    const l = labels(build({}));
    expect(l).not.toContain("转为笔记");
    expect(l).not.toContain("编辑笔记");
  });

  it("未转过时文案是「转为笔记」", () => {
    expect(labels(build({ onConvertToNote: () => {} }))).toContain("转为笔记");
  });

  it("已转过时文案改成「编辑笔记」——幂等路径下点它是去编辑旧那条，不是又存一份", () => {
    const l = labels(build({ onConvertToNote: () => {}, hasNote: true }));
    expect(l).toContain("编辑笔记");
    expect(l).not.toContain("转为笔记");
  });

  it("放在顶层而不是「更多操作」子菜单里（知识库主入口，藏二级就没人发现）", () => {
    const items = build({ onConvertToNote: () => {}, onEditTags: () => {} });
    expect(labels(items)).toContain("转为笔记");
    expect(subLabels(items, "更多操作")).not.toContain("转为笔记");
  });

  it("排在「删除」之前（删除始终是最后一项）", () => {
    const l = labels(build({ onConvertToNote: () => {} }));
    expect(l.indexOf("转为笔记")).toBeLessThan(l.indexOf("删除"));
    expect(l[l.length - 1]).toBe("删除");
  });

  it("点它调的就是传进来的回调", () => {
    const spy = vi.fn();
    build({ onConvertToNote: spy }).find((i) => i.label === "转为笔记")?.onClick?.();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
