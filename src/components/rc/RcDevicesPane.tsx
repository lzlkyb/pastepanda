/** 设备页只展示详情；保留无列表的来访确认观察者，避免移除旧卡后漏掉配对请求。 */
import type { ComponentProps } from "react";
import type { UseRc } from "@/hooks/useRc";
import { RcA2DeviceDetail } from "./RcA2DeviceDetail";
import { RcNearbyPairPane } from "./RcNearbyPairPane";

type DetailProps = ComponentProps<typeof RcA2DeviceDetail>;

export function RcDevicesPane({ rc, pairingOpen = false, onPairAccepted, ...detail }: DetailProps & { rc: UseRc; pairingOpen?: boolean; onPairAccepted?: (id: string) => void }) {
  return (
    <>
      <RcNearbyPairPane rc={rc} toast={detail.toast} onPairMore={detail.onPair} requestsOnly suspended={pairingOpen} onPairAccepted={onPairAccepted} />
      <RcA2DeviceDetail {...detail} />
    </>
  );
}
