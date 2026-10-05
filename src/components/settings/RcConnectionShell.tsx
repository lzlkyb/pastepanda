import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";
import { useDialogEscape } from "@/hooks/useDialogEscape";
import styles from "./RcConnect.module.css";

/** 配对与连接方式共用焦点、取消和尺寸；具体授权流程仍由各自组件负责。 */
export function RcConnectionShell({ title, subtitle, onClose, children }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode;
}) {
  const anim = useDialogAnim();
  useDialogEscape(onClose);
  return (
    <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={onClose}>
      <FocusTrap ariaLabel={title}>
        <motion.div {...anim.panel} className={`dialog-box ${styles.dialog}`} onClick={(event) => event.stopPropagation()}>
          <header className={styles.header}>
            <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
            <button type="button" className="dialog-close" aria-label="关闭" onClick={onClose}><X size={18} /></button>
          </header>
          {children}
        </motion.div>
      </FocusTrap>
    </motion.div>
  );
}
