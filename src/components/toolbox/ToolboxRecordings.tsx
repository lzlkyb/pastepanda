import { useState } from "react";
import { ChevronDown, Video } from "lucide-react";
import { RecRecentList } from "@/components/recsel/RecRecentList";
import styles from "../ToolboxView.module.css";

export function ToolboxRecordings({ expanded }: { expanded: boolean }) {
  const [open, setOpen] = useState(expanded);
  return <details className={styles.recordings} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Video size={16} />最近录制<ChevronDown size={16} /></summary>
    {/* Collapsing unmounts the list: reopening deliberately reloads the directory and task status. */}
    {open && <RecRecentList />}
  </details>;
}
