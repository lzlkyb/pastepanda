import { Radar, Search, X } from "lucide-react";
import connect from "@/components/settings/RcConnect.module.css";
import styles from "./RemoteComputerA2.module.css";

export function RcDeviceListTitle({ searchOpen, onSearch, onNearby }: {
  searchOpen: boolean; onSearch: () => void; onNearby?: () => void;
}) {
  return <div className={styles.sidebarTitleRow}>
    <h2>我的设备</h2>
    {onNearby && <button type="button" className={connect.nearButton} onClick={onNearby}><Radar size={14} aria-hidden="true" />附近设备</button>}
    <button type="button" className={searchOpen ? styles.searchToggleOn : styles.searchToggle}
      aria-label="搜索设备" aria-expanded={searchOpen} title="搜索设备（快捷键 /）" onClick={onSearch}>
      {searchOpen ? <X size={14} aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
    </button>
  </div>;
}
