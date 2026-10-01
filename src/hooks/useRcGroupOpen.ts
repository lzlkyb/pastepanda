/**
 * useRcGroupOpen — 设置页「远程电脑」四个折叠组的开合状态。
 *
 * 判据本身在 `lib/rcPrefs`（纯函数，可无环境测试），这里只管 React 侧的读写：
 * 用户态进 localStorage（不进 config——`save_config` 每次全量明文备份，
 * 点一下组头不该落盘），搜索非空时由 `rcGroupShouldOpen` 强制全展开、
 * 由 `rcGroupHeadInert` 把 `toggle` 停成空操作（两者同一判据，见 `inert`）。
 *
 * 🔴 收起 = **不渲染**组内的行（不是 `display:none`）。两个前提跟着成立：
 * ① `.settingsSections` 的 children 必须保持「标题 + 行」一层扁平；
 * ② 藏起来的组不参与搜索命中——所以「待确认请求有几台」这类**必须被看见**的
 *    计数只能放在组头摘要里，而摘要在收起态才显示。
 */
import { useCallback, useState } from "react";
import {
  rcGroupHeadInert,
  rcGroupShouldOpen,
  readRcGroupOpen,
  writeRcGroupOpen,
  type RcSettingsGroup,
} from "@/lib/rcPrefs";

export function useRcGroupOpen(filter: string) {
  const [userOpen, setUserOpen] = useState<Record<RcSettingsGroup, boolean>>(readRcGroupOpen);
  /** 搜索态：组头此刻是「假按钮」，点击与落盘都要停掉（判据见 `rcGroupHeadInert`）。 */
  const inert = rcGroupHeadInert(filter);

  const toggle = useCallback((group: RcSettingsGroup) => {
    if (inert) return;
    setUserOpen((prev) => {
      const next = { ...prev, [group]: !prev[group] };
      writeRcGroupOpen(next);
      return next;
    });
  }, [inert]);

  /**
   * `extraOpen` 给「有待确认请求 ⇒ 组 1 自动展开」这类**由数据决定**的强制展开。
   * 只能由调用方（拿着 `rc.status` 的编排层）传进来：组收起时它自己的行根本不在
   * DOM 里，判不了自己组内有没有请求。
   */
  const isOpen = useCallback(
    (group: RcSettingsGroup, extraOpen = false) =>
      extraOpen || rcGroupShouldOpen(userOpen[group], filter),
    [filter, userOpen],
  );

  return { isOpen, toggle, inert };
}
