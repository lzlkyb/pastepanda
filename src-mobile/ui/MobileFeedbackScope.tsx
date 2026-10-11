import { createContext, useContext, type ReactNode } from "react";
const Scope = createContext(false);
export function MobileFeedbackScope({ children }: { children: ReactNode }) {
  return <Scope.Provider value={true}>{children}</Scope.Provider>;
}
export function useMobileFeedbackScope() { return useContext(Scope); }
