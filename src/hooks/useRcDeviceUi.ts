/**
 * useRcDeviceUi — 设备详情面的改名 / 管理展开态。
 *
 * 🔴 必须挂在**不会被卸载**的父级（RcWorkbench）。详情面随工作台切页卸载时，
 * 局部 state 会把未保存的改名草稿一并丢掉（规则 15.2）。与会话历史上提同一模式。
 *
 * `syncPeer` 走渲染期比对 + setState（与原先 RcA2DeviceDetail 内写法一致）：
 * effect 版本会先渲染一帧上一台的展开态再收，视觉上闪一下。
 */
import { useRef, useState } from "react";
import type { TagColorKey } from "@/lib/rcDeviceTags";

export interface RcDeviceOrgDraft {
  remark: string;
  tagName: string;
  pickedColor: TagColorKey;
  saving: boolean;
}

export function useRcDeviceUi() {
  const [editingName, setEditingNameState] = useState(false);
  const [draftName, setDraftNameState] = useState("");
  const draftNameRef = useRef("");
  const nameRequest = useRef(0);
  const nameInFlight = useRef(false);
  const [savingName, setSavingName] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [manageFor, setManageFor] = useState<string | null>(null);
  // 草稿按设备保留在工作台，折叠/切页卸载编辑器不丢输入，也不丢保存中的状态。
  const [orgDrafts, setOrgDrafts] = useState<Record<string, RcDeviceOrgDraft>>({});
  const orgDraftFor = (peer: string, remark: string): RcDeviceOrgDraft =>
    orgDrafts[peer] ?? { remark, tagName: "", pickedColor: "blue", saving: false };
  const updateOrgDraft = (peer: string, remark: string, patch: Partial<RcDeviceOrgDraft>) => {
    setOrgDrafts((current) => ({
      ...current,
      [peer]: { ...(current[peer] ?? { remark, tagName: "", pickedColor: "blue", saving: false }), ...patch },
    }));
  };

  const setDraftName = (name: string) => {
    draftNameRef.current = name;
    setDraftNameState(name);
  };
  const invalidateNameSave = () => {
    nameRequest.current++;
    nameInFlight.current = false;
    setSavingName(false);
  };
  const setEditingName = (editing: boolean) => {
    if (!editing) invalidateNameSave();
    setEditingNameState(editing);
  };
  // Keep request ownership in the persistent workbench, including cancel and peer changes.
  const beginNameSave = (): number | null => {
    if (nameInFlight.current) return null;
    nameInFlight.current = true;
    setSavingName(true);
    return ++nameRequest.current;
  };
  const isNameSaveCurrent = (request: number, submittedDraft?: string) =>
    nameInFlight.current && request === nameRequest.current &&
    (submittedDraft === undefined || draftNameRef.current === submittedDraft);
  const finishNameSave = (request: number) => {
    if (!isNameSaveCurrent(request)) return;
    nameInFlight.current = false;
    setSavingName(false);
  };

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
    beginNameSave,
    isNameSaveCurrent,
    finishNameSave,
    manageOpen,
    setManageOpen,
    syncPeer,
    orgDraftFor,
    updateOrgDraft,
  };
}

export type RcDeviceUi = ReturnType<typeof useRcDeviceUi>;
