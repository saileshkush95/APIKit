// Environments live above both the header selector and the request pane, so
// they are held in context rather than drilled through every component.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { saveEnvironments, setSetting } from "../lib/api";
import { usePersist } from "../lib/persist";
import { newId, SETTINGS, workspaceDataOnce } from "../lib/storage";
import { environmentVars, type VarMap } from "../lib/vars";
import { useSync } from "./sync";
import { useWorkspaceId } from "./workspaces";
import type { Environment } from "../types";
import { notifyError } from "../lib/notify";

interface EnvironmentsValue {
  environments: Environment[];
  active: Environment | null;
  activeId: string | null;
  /** Variables of the active environment, ready for interpolation. */
  vars: VarMap;
  setActiveId: (id: string | null) => void;
  create: (name?: string) => Environment;
  update: (id: string, patch: Partial<Omit<Environment, "id">>) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  /** Used by scripts (`wrk.env.set`) to write variables back. */
  setVariables: (updates: Record<string, string>) => void;
}

const EnvironmentsContext = createContext<EnvironmentsValue | null>(null);

function makeEnvironment(name: string): Environment {
  return { id: newId(), name, variables: [{ name: "", value: "" }] };
}

export function EnvironmentsProvider({ children }: { children: ReactNode }) {
  const workspaceId = useWorkspaceId();
  // Bumped when a sync applied rows, so the view reflects the new data.
  const { revision } = useSync();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    workspaceDataOnce(workspaceId)
      .then((workspace) => {
        if (cancelled) return;
        setEnvironments(workspace.environments);
        setActiveId(workspace.settings[SETTINGS.activeEnvironment] || null);
      })
      .catch((e) => notifyError("Could not load environments", e))
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, revision]);

  usePersist(environments, ready, (value) =>
    saveEnvironments(workspaceId, value),
  );

  useEffect(() => {
    if (!ready) return;
    setSetting(workspaceId, SETTINGS.activeEnvironment, activeId ?? "").catch(
      () => {},
    );
  }, [activeId, ready, workspaceId]);

  const create = useCallback((name = "New Environment") => {
    const env = makeEnvironment(name);
    setEnvironments((prev) => [...prev, env]);
    setActiveId(env.id);
    return env;
  }, []);

  const update = useCallback(
    (id: string, patch: Partial<Omit<Environment, "id">>) => {
      setEnvironments((prev) =>
        prev.map((env) => (env.id === id ? { ...env, ...patch } : env)),
      );
    },
    [],
  );

  const duplicate = useCallback((id: string) => {
    setEnvironments((prev) => {
      const source = prev.find((env) => env.id === id);
      if (!source) return prev;
      const copy: Environment = {
        id: newId(),
        name: `${source.name} copy`,
        variables: source.variables.map((v) => ({ ...v })),
      };
      const index = prev.findIndex((env) => env.id === id);
      const next = [...prev];
      next.splice(index + 1, 0, copy);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setEnvironments((prev) => prev.filter((env) => env.id !== id));
    setActiveId((current) => (current === id ? null : current));
  }, []);

  const active = useMemo(
    () => environments.find((env) => env.id === activeId) ?? null,
    [environments, activeId],
  );

  // Script writes go to the active environment; without one they live for the
  // session only, so a chained request still sees them.
  const [sessionVars, setSessionVars] = useState<Record<string, string>>({});

  const setVariables = useCallback(
    (updates: Record<string, string>) => {
      if (Object.keys(updates).length === 0) return;
      if (!active) {
        setSessionVars((prev) => ({ ...prev, ...updates }));
        return;
      }
      setEnvironments((prev) =>
        prev.map((env) => {
          if (env.id !== active.id) return env;
          const variables = [...env.variables];
          for (const [name, value] of Object.entries(updates)) {
            const index = variables.findIndex((v) => v.name === name);
            if (index === -1) variables.splice(variables.length - 1, 0, { name, value });
            else variables[index] = { name, value };
          }
          return { ...env, variables };
        }),
      );
    },
    [active],
  );

  const value = useMemo<EnvironmentsValue>(
    () => ({
      environments,
      active,
      activeId: active?.id ?? null,
      vars: { ...environmentVars(active), ...sessionVars },
      setActiveId,
      create,
      update,
      duplicate,
      remove,
      setVariables,
    }),
    [
      environments,
      active,
      sessionVars,
      create,
      update,
      duplicate,
      remove,
      setVariables,
    ],
  );

  return (
    <EnvironmentsContext.Provider value={value}>
      {children}
    </EnvironmentsContext.Provider>
  );
}

export function useEnvironments(): EnvironmentsValue {
  const value = useContext(EnvironmentsContext);
  if (!value) {
    throw new Error("useEnvironments must be used inside <EnvironmentsProvider>");
  }
  return value;
}
