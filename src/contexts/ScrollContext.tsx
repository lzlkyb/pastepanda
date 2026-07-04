import { createContext, useContext, RefObject } from "react";
import type Lenis from "lenis";

interface ScrollContextValue {
  scrollRef: RefObject<HTMLDivElement | null>;
  lenisRef: RefObject<Lenis | null>;
}

const ScrollContext = createContext<ScrollContextValue | null>(null);

export function ScrollProvider({
  scrollRef,
  lenisRef,
  children,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  lenisRef: RefObject<Lenis | null>;
  children: React.ReactNode;
}) {
  return (
    <ScrollContext.Provider value={{ scrollRef, lenisRef }}>
      {children}
    </ScrollContext.Provider>
  );
}

export function useScrollRef(): RefObject<HTMLDivElement | null> | null {
  return useContext(ScrollContext)?.scrollRef ?? null;
}

export function useLenisRef(): RefObject<Lenis | null> | null {
  return useContext(ScrollContext)?.lenisRef ?? null;
}
