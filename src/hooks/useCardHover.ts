import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type RefObject } from "react";
import type { AppConfig } from "@/stores/appStore";

/** Pointer, keyboard and copy feedback share one lifetime, including the gap to the popover. */
export function useCardHover(itemId: string, mode: AppConfig["hover_mode"], cardRef: RefObject<HTMLDivElement | null>) {
  const [active, setActive] = useState<{ itemId: string; mode: typeof mode; open: boolean }>({ itemId, mode, open: false });
  const [popoverFlipDown, setPopoverFlipDown] = useState(false);
  const pointer = useRef(false);
  const focused = useRef(false);
  const mouseFocus = useRef(false);
  const copying = useRef(false);
  const live = useRef(true);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hovered = mode !== "off" && active.itemId === itemId && active.mode === mode && active.open;

  const clearTimers = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    live.current = true;
    pointer.current = focused.current = copying.current = mouseFocus.current = false;
    clearTimers();
    setActive({ itemId, mode, open: false });
    return () => { live.current = false; clearTimers(); };
  }, [itemId, mode, clearTimers]);

  // Keep the virtual row above its neighbours for the whole popover interaction, not just mouse hover.
  useLayoutEffect(() => {
    if (!hovered || mode !== "popover") return;
    const row = cardRef.current?.parentElement?.parentElement;
    if (!row) return;
    const previous = row.style.zIndex;
    row.style.zIndex = "50";
    return () => { row.style.zIndex = previous; };
  }, [hovered, mode, cardRef]);

  const open = useCallback(() => {
    if (!live.current || mode === "off") return;
    if (mode === "popover" && cardRef.current) {
      setPopoverFlipDown(cardRef.current.getBoundingClientRect().top < 360);
    }
    setActive({ itemId, mode, open: true });
  }, [itemId, mode, cardRef]);

  const closeWhenIdle = useCallback(() => {
    clearTimers();
    if (!live.current || mode === "off") return;
    if (pointer.current || focused.current || copying.current) return;
    closeTimer.current = setTimeout(() => setActive({ itemId, mode, open: false }), 150);
  }, [clearTimers, itemId, mode]);

  const enterHover = useCallback(() => {
    if (mode === "off") return;
    pointer.current = true;
    clearTimers();
    // Inline controls respond immediately; previews retain the intent delay when scanning a list.
    if (mode === "inline" || hovered) { open(); return; }
    openTimer.current = setTimeout(open, 180);
  }, [mode, hovered, clearTimers, open]);

  const scheduleClose = useCallback(() => {
    pointer.current = false;
    closeWhenIdle();
  }, [closeWhenIdle]);

  const onFocus = useCallback(() => {
    if (mode === "off") return;
    focused.current = !mouseFocus.current;
    clearTimers();
    open();
  }, [mode, clearTimers, open]);

  // A mouse click also focuses a button. Only keyboard focus should pin the toolbar after mouse leave.
  const onMouseDownCapture = useCallback(() => {
    mouseFocus.current = true;
    focused.current = false;
  }, []);
  const onKeyDownCapture = useCallback(() => {
    mouseFocus.current = false;
    onFocus();
  }, [onFocus]);

  const onBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    focused.current = false;
    closeWhenIdle();
  }, [closeWhenIdle]);

  const onCopyFeedbackChange = useCallback((visible: boolean) => {
    if (!live.current) return;
    copying.current = visible;
    if (visible) clearTimers();
    else closeWhenIdle();
  }, [clearTimers, closeWhenIdle]);

  return { hovered, popoverFlipDown, enterHover, scheduleClose, onFocus, onBlur, onMouseDownCapture, onKeyDownCapture, onCopyFeedbackChange };
}
