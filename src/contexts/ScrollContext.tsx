import { createContext, useContext, RefObject } from "react";

interface ScrollContextValue {
  scrollRef: RefObject<HTMLDivElement | null>;
}

const ScrollContext = createContext<ScrollContextValue | null>(null);

export function ScrollProvider({
  scrollRef,
  children,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  return (
    <ScrollContext.Provider value={{ scrollRef }}>
      {children}
    </ScrollContext.Provider>
  );
}

export function useScrollRef(): RefObject<HTMLDivElement | null> | null {
  return useContext(ScrollContext)?.scrollRef ?? null;
}
