// The request currently open in the client, published so other views (load
// testing) can offer "use active request" without prop-drilling through the app.

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { RequestDraft } from "../types";

export interface ActiveRequest extends RequestDraft {
  name: string;
}

interface ActiveRequestValue {
  active: ActiveRequest | null;
  setActive: (request: ActiveRequest | null) => void;
}

const ActiveRequestContext = createContext<ActiveRequestValue | null>(null);

export function ActiveRequestProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveRequest | null>(null);
  const value = useMemo(() => ({ active, setActive }), [active]);
  return (
    <ActiveRequestContext.Provider value={value}>
      {children}
    </ActiveRequestContext.Provider>
  );
}

export function useActiveRequest(): ActiveRequestValue {
  const value = useContext(ActiveRequestContext);
  if (!value) {
    throw new Error(
      "useActiveRequest must be used inside <ActiveRequestProvider>",
    );
  }
  return value;
}
