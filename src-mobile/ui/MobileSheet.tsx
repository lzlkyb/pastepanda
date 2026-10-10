import { useEffect, useId, useRef, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, X } from "lucide-react";
import { useMobileBack } from "./useMobileBack";
import { useSheetDrag } from "./useSheetDrag";
import { useMobileLayout } from "./useMobileLayout";
import styles from "./MobileUi.module.css";

export function MobileSheet({
  open,
  title,
  description,
  onClose,
  onBack,
  backPriority = 10,
  children,
  footer,
  actions,
  bodyClassName,
  contentClassName,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  /** Return to the source step; close remains an explicit exit from the whole flow. */
  onBack?: () => void;
  backPriority?: number;
  children: ReactNode;
  /** Operation results remain visible while the controls scroll on short screens. */
  footer?: ReactNode;
  /** Primary actions stay reachable independently of long feedback on short screens. */
  actions?: ReactNode;
  bodyClassName?: string;
  contentClassName?: string;
}) {
  const landscape = useMobileLayout();
  const back = onBack ?? onClose;
  const { present, sheetRef, ...dragEvents } = useSheetDrag(open, back, landscape);
  const saved = useRef({ title, description, children, footer, actions });
  const restoreFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) saved.current = { title, description, children, footer, actions };
  }, [open, title, description, children, footer, actions]);
  useEffect(() => {
    if (!present) return;
    // Pause underlying glass while a sheet owns focus; content stays sharp.
    const body = document.body;
    const count = Number(body.dataset.mobileSheets || 0) + 1;
    body.dataset.mobileSheets = String(count);
    return () => {
      const remaining = Number(body.dataset.mobileSheets || 1) - 1;
      if (remaining) body.dataset.mobileSheets = String(remaining);
      else delete body.dataset.mobileSheets;
    };
  }, [present]);
  const content = open ? { title, description, children, footer, actions } : saved.current;
  const descriptionId = useId();
  useMobileBack(open, back, true, backPriority, sheetRef);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) back();
      }}
    >
      {present && (
        <Dialog.Portal forceMount>
          <Dialog.Overlay forceMount className={styles.overlay} />
          <Dialog.Content
            forceMount
            ref={sheetRef}
            className={`${styles.sheet} ${contentClassName ?? ""}`}
            aria-describedby={content.description ? descriptionId : undefined}
            onOpenAutoFocus={() => {
              restoreFocus.current = document.activeElement as HTMLElement;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!document.querySelector('[role="dialog"][data-state="open"]') && restoreFocus.current?.isConnected)
                if (!restoreFocus.current.closest('[hidden],[inert],[aria-hidden="true"]')) restoreFocus.current.focus({ preventScroll: true });
            }}
          >
            <button type="button" className={styles.dragHandle} aria-label={landscape ? "向右拖动或点击收起面板" : "向下拖动或点击收起面板"} {...dragEvents}>
              <span aria-hidden="true" />
            </button>
            <header className={styles.sheetHead} {...dragEvents}>
              {onBack && <button type="button" className={styles.textButton} onClick={onBack}><ArrowLeft size={18} aria-hidden="true" />返回</button>}
              <Dialog.Title className={styles.sheetTitle}>{content.title}</Dialog.Title>
              <button type="button" className={styles.closeButton} onClick={onClose}>
                <X size={18} aria-hidden="true" />
                <span>{onBack ? "关闭全部" : "关闭"}</span>
              </button>
            </header>
            {content.description && (
              <Dialog.Description id={descriptionId} className={styles.description}>
                {content.description}
              </Dialog.Description>
            )}
            <div className={`${styles.sheetBody} ${bodyClassName ?? ""}`}>{content.children}</div>
            {content.footer && <div className={styles.sheetFooter}>{content.footer}</div>}
            {content.actions && <div className={styles.sheetActions}>{content.actions}</div>}
          </Dialog.Content>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  );
}
