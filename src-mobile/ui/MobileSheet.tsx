import { useEffect, useId, useRef, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useMobileBack } from "./useMobileBack";
import { useSheetDrag } from "./useSheetDrag";
import styles from "./MobileUi.module.css";

export function MobileSheet({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { present, sheetRef, ...dragEvents } = useSheetDrag(open, onClose);
  const saved = useRef({ title, description, children });
  const restoreFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) saved.current = { title, description, children };
  }, [open, title, description, children]);
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
  const content = open ? { title, description, children } : saved.current;
  const descriptionId = useId();
  useMobileBack(open, onClose);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      {present && (
        <Dialog.Portal forceMount>
          <Dialog.Overlay forceMount className={styles.overlay} />
          <Dialog.Content
            forceMount
            ref={sheetRef}
            className={styles.sheet}
            aria-describedby={content.description ? descriptionId : undefined}
            onOpenAutoFocus={() => {
              restoreFocus.current = document.activeElement as HTMLElement;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!document.querySelector('[role="dialog"][data-state="open"]') && restoreFocus.current?.isConnected)
                restoreFocus.current.focus();
            }}
          >
            <button type="button" className={styles.dragHandle} aria-label="向下拖动或点击收起面板" {...dragEvents}>
              <span aria-hidden="true" />
            </button>
            <header className={styles.sheetHead}>
              <Dialog.Title className={styles.sheetTitle}>{content.title}</Dialog.Title>
              <Dialog.Close className={styles.closeButton}>
                <X size={18} aria-hidden="true" />
                <span>关闭</span>
              </Dialog.Close>
            </header>
            {content.description && (
              <Dialog.Description id={descriptionId} className={styles.description}>
                {content.description}
              </Dialog.Description>
            )}
            <div className={styles.sheetBody}>{content.children}</div>
          </Dialog.Content>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  );
}
