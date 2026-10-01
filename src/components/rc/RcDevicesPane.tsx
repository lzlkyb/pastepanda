/**
 * RcDevicesPane — 设备页主区的拼装层：常驻配对卡 + 设备详情。
 *
 * 2026-09-29 统一入口（设计稿 `design/远程电脑-一键配对-统一入口-设计稿.html` §1）：
 * 配对入口从侧栏折叠里搬到主区第一块。放在这个拼装层而不是直接塞进
 * `RcA2DeviceDetail`，是因为两件事的生死不同——详情面随选中设备整块重渲染，
 * 而配对卡必须在「换设备 / 进空态 / 配对进行中」全程活着（规则 15.2：
 * 条件渲染的容器会卸载子组件，卡上那轮配对经不起卸载）。
 *
 * 本文件只做透传 + 定位，不写业务逻辑。`RcWorkbench` 贴 300 行红线，
 * 所以拼装收在这里：那边只换一个组件名、加一行 `rc`。
 */
import type { ComponentProps } from "react";
import type { UseRc } from "@/hooks/useRc";
import { RcA2DeviceDetail } from "./RcA2DeviceDetail";
import { RcNearbyPairPane } from "./RcNearbyPairPane";

type DetailProps = ComponentProps<typeof RcA2DeviceDetail>;

export function RcDevicesPane({ rc, ...detail }: DetailProps & { rc: UseRc }) {
  return (
    <>
      {/* 卡上的主按钮与详情空态「开始配对」共用同一个回调：都打开配对界面。 */}
      <RcNearbyPairPane rc={rc} toast={detail.toast} onPairMore={detail.onPair} />
      <RcA2DeviceDetail {...detail} />
    </>
  );
}
