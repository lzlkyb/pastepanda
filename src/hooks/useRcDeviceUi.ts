/**
 * useRcDeviceUi — 设备详情面的改名 / 管理展开态。
 *
 * 🔴 必须挂在**不会被卸载**的父级（RcWorkbench）。详情面随工作台切页卸载时，
 * 局部 state 会把未保存的改名草稿一并丢掉（规则 15.2）。与会话历史上提同一模式。
 *
 * `syncPeer` 走渲染期比对 + setState（与原先 RcA2DeviceDetail 内写法一致）：
 * effect 版本会先渲染一帧上一台的展开态再收，视觉上闪一下。
 */
import { useState } from "react";

export function useRcDeviceUi() {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [manageFor, setManageFor] = useState<string | null>(null);

  /** 换设备才重置；切页再回来（同一台）保留草稿。 */
  const syncPeer = (peerKey: string | null) => {
    if (manageFor === peerKey) return;
    setManageFor(peerKey);
    setManageOpen(false);
    setEditingName(false);
    setDraftName("");
  };

  return {
    editingName,
    setEditingName,
    draftName,
    setDraftName,
    savingName,
    setSavingName,
    manageOpen,
    setManageOpen,
    syncPeer,
  };
}

export type RcDeviceUi = ReturnType<typeof useRcDeviceUi>;
