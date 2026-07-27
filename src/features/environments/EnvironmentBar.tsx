import { Select } from "../../shared/components/Field";
import { useState } from "react";
import { useEnvironments } from "../../shared/state/environments";
import { EnvironmentManager } from "./EnvironmentManager";

const NO_ENV = "__none__";

/** Active-environment picker plus the entry point to the manager modal. */
export function EnvironmentBar() {
  const { environments, activeId, setActiveId } = useEnvironments();
  const [managing, setManaging] = useState(false);

  return (
    <>
      <div data-tour="environments" className="flex items-center gap-1.5">
        <Select
          value={activeId ?? NO_ENV}
          onChange={(e) =>
            setActiveId(e.target.value === NO_ENV ? null : e.target.value)
          }
          size="compact"
          className="w-44"
          title="Active environment"
        >
          <option value={NO_ENV}>No environment</option>
          {environments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </Select>
        <button
          onClick={() => setManaging(true)}
          className="flex h-7 items-center rounded-md px-2 text-xs text-muted hover:bg-elevated hover:text-ink"
          title="Manage environments"
        >
          Manage
        </button>
      </div>
      {managing && <EnvironmentManager onClose={() => setManaging(false)} />}
    </>
  );
}
