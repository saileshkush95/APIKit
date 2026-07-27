// Environments: the {{variable}} sets a request is resolved against.

import { useMemo } from "react";
import { create } from "zustand";
import { saveEnvironments, setSetting } from "../lib/api";
import { notifyError } from "../lib/notify";
import { createSaver } from "../lib/save";
import { newId, SETTINGS, workspaceDataOnce } from "../lib/storage";
import { environmentVars, type VarMap } from "../lib/vars";
import type { Environment } from "../types";

function makeEnvironment(name: string): Environment {
  return { id: newId(), name, variables: [{ name: "", value: "" }] };
}

interface EnvironmentsStore {
  workspaceId: string;
  environments: Environment[];
  activeId: string | null;
  /** Script writes with no active environment live here for the session. */
  sessionVars: Record<string, string>;
  ready: boolean;
  load: (workspaceId: string) => Promise<void>;
  setActiveId: (id: string | null) => void;
  create: (name?: string) => Environment;
  update: (id: string, patch: Partial<Omit<Environment, "id">>) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  setVariables: (updates: Record<string, string>) => void;
}

export const useEnvironmentsStore = create<EnvironmentsStore>()((set, get) => {
  const saveSoon = createSaver<{ workspaceId: string; list: Environment[] }>(
    ({ workspaceId, list }) => saveEnvironments(workspaceId, list),
  );

  function commit(environments: Environment[]) {
    set({ environments });
    saveSoon({ workspaceId: get().workspaceId, list: environments });
  }

  return {
    workspaceId: "",
    environments: [],
    activeId: null,
    sessionVars: {},
    ready: false,

    load: async (workspaceId) => {
      set({ ready: false, workspaceId });
      try {
        const workspace = await workspaceDataOnce(workspaceId);
        set({
          environments: workspace.environments,
          activeId: workspace.settings[SETTINGS.activeEnvironment] || null,
        });
      } catch (e) {
        notifyError("Could not load environments", e);
      } finally {
        set({ ready: true });
      }
    },

    setActiveId: (activeId) => {
      set({ activeId });
      setSetting(
        get().workspaceId,
        SETTINGS.activeEnvironment,
        activeId ?? "",
      ).catch(() => {});
    },

    create: (name = "New Environment") => {
      const environment = makeEnvironment(name);
      commit([...get().environments, environment]);
      get().setActiveId(environment.id);
      return environment;
    },

    update: (id, patch) =>
      commit(
        get().environments.map((env) =>
          env.id === id ? { ...env, ...patch } : env,
        ),
      ),

    duplicate: (id) => {
      const list = get().environments;
      const source = list.find((env) => env.id === id);
      if (!source) return;
      const copy: Environment = {
        id: newId(),
        name: `${source.name} copy`,
        variables: source.variables.map((variable) => ({ ...variable })),
      };
      const next = [...list];
      next.splice(list.findIndex((env) => env.id === id) + 1, 0, copy);
      commit(next);
    },

    remove: (id) => {
      commit(get().environments.filter((env) => env.id !== id));
      if (get().activeId === id) get().setActiveId(null);
    },

    setVariables: (updates) => {
      if (Object.keys(updates).length === 0) return;
      const { environments, activeId } = get();
      const active = environments.find((env) => env.id === activeId);

      // Script writes go to the active environment; without one they live for
      // the session only, so a chained request still sees them.
      if (!active) {
        set({ sessionVars: { ...get().sessionVars, ...updates } });
        return;
      }

      commit(
        environments.map((env) => {
          if (env.id !== active.id) return env;
          const variables = [...env.variables];
          for (const [name, value] of Object.entries(updates)) {
            const index = variables.findIndex((v) => v.name === name);
            if (index === -1) {
              variables.splice(Math.max(0, variables.length - 1), 0, {
                name,
                value,
              });
            } else {
              variables[index] = { ...variables[index], value };
            }
          }
          return { ...env, variables };
        }),
      );
    },
  };
});

/** Same shape the provider exposed, so consumers are unchanged. */
export function useEnvironments() {
  // Each slice is selected on its own. Building `vars` inside the selector
  // would return a new object on every comparison, which never settles and
  // ends in "Maximum update depth exceeded".
  const environments = useEnvironmentsStore((s) => s.environments);
  const activeId = useEnvironmentsStore((s) => s.activeId);
  const sessionVars = useEnvironmentsStore((s) => s.sessionVars);
  const setActiveId = useEnvironmentsStore((s) => s.setActiveId);
  const create = useEnvironmentsStore((s) => s.create);
  const update = useEnvironmentsStore((s) => s.update);
  const duplicate = useEnvironmentsStore((s) => s.duplicate);
  const remove = useEnvironmentsStore((s) => s.remove);
  const setVariables = useEnvironmentsStore((s) => s.setVariables);

  const active = useMemo(
    () => environments.find((env) => env.id === activeId) ?? null,
    [environments, activeId],
  );
  const vars = useMemo<VarMap>(
    () => ({ ...environmentVars(active), ...sessionVars }),
    [active, sessionVars],
  );

  return {
    environments,
    active,
    activeId: active?.id ?? null,
    vars,
    setActiveId,
    create,
    update,
    duplicate,
    remove,
    setVariables,
  };
}
