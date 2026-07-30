import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { Input } from "../../shared/components/Field";
import { Modal } from "../../shared/components/Modal";
import {
  grpcMethods,
  grpcServices,
  type GrpcMethodInfo,
} from "../../shared/lib/api";
import { interpolate } from "../../shared/lib/vars";
import { useEnvironments } from "../../shared/state/environments";
import type { RequestConfig } from "../../shared/types";

interface Props {
  target: string;
  config: RequestConfig;
  onChange: (patch: Partial<RequestConfig>) => void;
  /** Chosen method, and a body skeleton to start from. */
  onPick: (method: string, template: string) => void;
  onClose: () => void;
}

/**
 * Picks a gRPC method, from `.proto` files or from server reflection.
 *
 * Reflection is off by default in most production servers, so `.proto` files are
 * not a fallback here — for a lot of real services they are the only route. With
 * files chosen this panel needs no server at all, and the method list works
 * before anything is running.
 */
export function GrpcSchemaPanel({
  target,
  config,
  onChange,
  onPick,
  onClose,
}: Props) {
  const { vars } = useEnvironments();
  const [services, setServices] = useState<string[]>([]);
  const [service, setService] = useState<string | null>(null);
  const [methods, setMethods] = useState<GrpcMethodInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const protoFiles = config.grpcProtoFiles ?? [];
  const importPaths = config.grpcImportPaths ?? [];
  const usingProtos = protoFiles.some((path) => path.trim() !== "");

  function spec() {
    return {
      target: interpolate(target, vars),
      method: "",
      body: "",
      metadata: [],
      plaintext: config.grpcPlaintext,
      protoFiles,
      importPaths,
    };
  }

  async function loadServices() {
    setBusy(true);
    setError(null);
    setService(null);
    setMethods([]);
    try {
      setServices(await grpcServices(spec()));
    } catch (e) {
      setError(String(e));
      setServices([]);
    } finally {
      setBusy(false);
    }
  }

  async function loadMethods(name: string) {
    setBusy(true);
    setError(null);
    setService(name);
    try {
      setMethods(await grpcMethods(spec(), name));
    } catch (e) {
      setError(String(e));
      setMethods([]);
    } finally {
      setBusy(false);
    }
  }

  async function addProtoFiles() {
    const picked = await open({
      multiple: true,
      title: "Choose .proto files",
      filters: [{ name: "Protocol buffers", extensions: ["proto"] }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length > 0) {
      onChange({ grpcProtoFiles: [...protoFiles, ...paths] });
    }
  }

  async function addImportPath() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose an import directory",
    });
    if (typeof picked === "string") {
      onChange({ grpcImportPaths: [...importPaths, picked] });
    }
  }

  const button =
    "rounded-md border border-edge px-2.5 py-1 text-[11px] text-ink hover:border-brand disabled:cursor-default disabled:opacity-40";

  function kindOf(method: GrpcMethodInfo): string {
    if (method.clientStreaming && method.serverStreaming) return "bidirectional streaming";
    if (method.clientStreaming) return "client streaming";
    if (method.serverStreaming) return "server streaming";
    return "unary";
  }

  return (
    <Modal title="gRPC methods" width="max-w-3xl" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <section>
          <div className="mb-1 text-[11px] font-medium text-ink">
            .proto files
          </div>
          <p className="mb-1.5 text-[10px] leading-relaxed text-muted">
            Compiled here, with no protoc needed. Each file's own directory is
            searched for imports, so a self-contained file needs no import path.
            Leave this empty to use server reflection instead.
          </p>

          <div className="flex flex-col gap-1">
            {protoFiles.map((path, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted"
                  title={path}
                >
                  {path}
                </span>
                <button
                  onClick={() =>
                    onChange({
                      grpcProtoFiles: protoFiles.filter((_, i) => i !== index),
                    })
                  }
                  className="px-1 text-base leading-none text-muted hover:text-err"
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
            {importPaths.map((path, index) => (
              <div key={`i${index}`} className="flex items-center gap-1.5">
                <span className="flex-none text-[10px] text-muted">import</span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted"
                  title={path}
                >
                  {path}
                </span>
                <button
                  onClick={() =>
                    onChange({
                      grpcImportPaths: importPaths.filter((_, i) => i !== index),
                    })
                  }
                  className="px-1 text-base leading-none text-muted hover:text-err"
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="mt-1.5 flex items-center gap-1.5">
            <button className={button} onClick={addProtoFiles}>
              Add .proto files
            </button>
            <button className={button} onClick={addImportPath}>
              Add import directory
            </button>
          </div>
        </section>

        <section className="border-t border-edge pt-3">
          <div className="flex items-center gap-2">
            <Input
              value={target}
              readOnly
              size="compact"
              className="font-mono"
              title="The target from the address bar"
            />
            <button className={button} disabled={busy} onClick={loadServices}>
              {busy ? "Loading…" : usingProtos ? "List from files" : "Reflect"}
            </button>
          </div>
          {!usingProtos && (
            <p className="mt-1 text-[10px] text-muted">
              No .proto files chosen, so the server will be asked for its
              descriptors. That only works if it exposes reflection.
            </p>
          )}
        </section>

        {error && (
          <div className="whitespace-pre-wrap rounded border border-err/40 px-2 py-1.5 text-[11px] text-err">
            {error}
          </div>
        )}

        {services.length > 0 && (
          <div className="flex max-h-80 gap-3 border-t border-edge pt-3">
            <div className="w-64 flex-none overflow-y-auto">
              <div className="mb-1 text-[10px] font-medium text-muted">
                Services
              </div>
              {services.map((name) => (
                <button
                  key={name}
                  onClick={() => loadMethods(name)}
                  className={`block w-full truncate rounded px-1.5 py-1 text-left font-mono text-[11px] ${
                    service === name
                      ? "bg-elevated text-ink"
                      : "text-muted hover:text-ink"
                  }`}
                  title={name}
                >
                  {name}
                </button>
              ))}
            </div>

            <div className="min-w-0 flex-1 overflow-y-auto">
              <div className="mb-1 text-[10px] font-medium text-muted">
                Methods
              </div>
              {service === null && (
                <p className="text-[11px] text-muted">Choose a service.</p>
              )}
              {service !== null && methods.length === 0 && !busy && (
                <p className="text-[11px] text-muted">
                  That service has no methods.
                </p>
              )}
              {methods.map((method) => (
                <button
                  key={method.fullName}
                  onClick={() => {
                    // A client-streaming method takes an array of messages, so
                    // the skeleton is wrapped to show that up front.
                    onPick(
                      method.fullName,
                      method.clientStreaming
                        ? `[\n${method.inputTemplate}\n]`
                        : method.inputTemplate,
                    );
                    onClose();
                  }}
                  className="block w-full rounded px-1.5 py-1 text-left hover:bg-elevated"
                  title={`${method.inputType} → ${method.outputType}`}
                >
                  <span className="block font-mono text-[11px] text-ink">
                    {method.name}
                  </span>
                  <span className="block text-[10px] text-muted">
                    {kindOf(method)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
