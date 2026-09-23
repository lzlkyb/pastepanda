/**
 * RcDeviceManageActions — 详情面「管理此设备」展开后的动作集合（批5b）。
 *
 * 原先是常驻的 `设备权限` 一级标题 + 4 个按钮（一行半的宽度），稿把它收进
 * 「连接与权限」区块标题右侧的入口。收纳后默认只占一个链接按钮的位置，
 * 展开形态仍是原来那 4 个按钮——样式与语义都没变，只是不再常驻喊话。
 *
 * 用**内联展开**而不是浮层菜单：详情面 body 是滚动容器，绝对定位的浮层会被
 * `overflow` 裁掉（本项目已有两次同类事故：主窗导出下拉、格式栏菜单），
 * 而这里展开后把下方 facts 推下去并无副作用。展开态由父组件按 `node_id`
 * 变化重置——换设备时不能留着上一台的管理面板。
 */
import { Download, Shield, ShieldCheck, Trash2 } from "lucide-react";
import type { RcTargetDevice } from "@/lib/api/rc";
import type { useRcDeviceActions } from "@/hooks/useRcDeviceActions";
import styles from "./RemoteComputerA2.module.css";

export function RcDeviceManageActions({
  target,
  name,
  busy,
  actions,
  onPair,
}: {
  target: RcTargetDevice;
  name: string;
  busy: boolean;
  actions: ReturnType<typeof useRcDeviceActions>;
  onPair: () => void;
}) {
  return (
    <div className={styles.managementActions}>
      <button
        type="button"
        className={styles.secondaryButton}
        disabled={busy}
        onClick={() => void actions.setAllowed(target.node_id, target.denied)}
      >
        <Shield size={14} aria-hidden="true" />
        {target.denied ? "允许连接本机" : "禁止连接本机"}
      </button>
      {target.source === "rc" ? (
        <>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy || target.denied}
            onClick={() => void actions.toggleTrust(target.node_id, !target.trusted, name)}
          >
            <ShieldCheck size={14} aria-hidden="true" />
            {/* U8 术语统一：与设置页「免确认设备」、被控视图「开启免确认」同名 */}
            {target.trusted ? "关闭免确认" : "开启免确认"}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy || target.denied}
            onClick={() => void actions.toggleAutoAccept(target.node_id, !target.auto_accept)}
          >
            <Download size={14} aria-hidden="true" />
            {target.auto_accept ? "关闭自动接收文件" : "开启自动接收文件"}
          </button>
          <button
            type="button"
            className={styles.dangerButton}
            disabled={busy}
            onClick={() => void actions.forget(target.node_id, name)}
          >
            <Trash2 size={14} aria-hidden="true" />
            移除设备
          </button>
        </>
      ) : (
        <button type="button" className={styles.primaryButton} onClick={onPair}>
          完成远程配对
        </button>
      )}
    </div>
  );
}
