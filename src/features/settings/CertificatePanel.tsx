import { open } from "@tauri-apps/plugin-dialog";
import { Input } from "../../shared/components/Field";
import { Toggle } from "../../shared/components/Toggle";
import { certificateFor, hostOf } from "../../shared/lib/certificates";
import { newId } from "../../shared/lib/storage";
import { useSettings } from "../../shared/state/settings";
import { useState } from "react";
import type { ClientCertificate } from "../../shared/types";

const PEM_FILTER = [
  { name: "PEM certificate", extensions: ["pem", "crt", "cer", "key"] },
];

function FileField({
  value,
  placeholder,
  title,
  onChange,
}: {
  value: string;
  placeholder: string;
  title: string;
  onChange: (path: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        size="compact"
        title={value || title}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono"
      />
      <button
        type="button"
        onClick={async () => {
          const picked = await open({ multiple: false, filters: PEM_FILTER, title });
          if (typeof picked === "string") onChange(picked);
        }}
        className="flex-none rounded border border-edge px-1.5 py-0.5 text-[11px] text-muted hover:border-brand hover:text-ink"
      >
        Browse…
      </button>
    </div>
  );
}

/**
 * Client certificates and extra certificate authorities.
 *
 * Only paths are stored — see `ClientCertificate`. The alternative to trusting a
 * private CA here is switching certificate verification off wholesale, which
 * stops checking every other server too, so this panel exists partly to make
 * that unnecessary.
 */
export function CertificatePanel() {
  const { settings, update } = useSettings();
  const certificates = settings.clientCertificates ?? [];
  const caPaths = settings.caCertificatePaths ?? [];
  const [probe, setProbe] = useState("");

  function patch(id: string, change: Partial<ClientCertificate>) {
    update({
      clientCertificates: certificates.map((certificate) =>
        certificate.id === id ? { ...certificate, ...change } : certificate,
      ),
    });
  }

  function add() {
    update({
      clientCertificates: [
        ...certificates,
        { id: newId(), host: "", certPath: "", keyPath: "", enabled: true },
      ],
    });
  }

  function remove(id: string) {
    update({
      clientCertificates: certificates.filter(
        (certificate) => certificate.id !== id,
      ),
    });
  }

  const probeHost = hostOf(probe);
  const probeMatch = probe.trim() ? certificateFor(probe, certificates) : null;

  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="text-xs font-semibold text-ink">Client certificates</h3>
        <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted">
          Presented when a server asks for one. The host is matched exactly, or
          with a single leading <span className="font-mono">*.</span> wildcard
          covering one label — so <span className="font-mono">*.example.com</span>{" "}
          covers <span className="font-mono">api.example.com</span> but not{" "}
          <span className="font-mono">example.com</span>. An exact host wins over
          a wildcard.
        </p>

        <div className="mt-2 flex flex-col gap-2">
          {certificates.length === 0 && (
            <p className="text-[11px] text-muted">
              None configured. Requests go out without a client certificate.
            </p>
          )}

          {certificates.map((certificate) => (
            <div
              key={certificate.id}
              className={`rounded-md border border-edge p-2 ${
                certificate.enabled === false ? "opacity-50" : ""
              }`}
            >
              <div className="mb-1.5 flex items-center gap-2">
                <Input
                  value={certificate.host}
                  spellCheck={false}
                  placeholder="api.example.com"
                  size="compact"
                  onChange={(e) => patch(certificate.id, { host: e.target.value })}
                  className="w-64 font-mono"
                />
                <div className="ml-auto flex items-center gap-2">
                  <Toggle
                    checked={certificate.enabled !== false}
                    onChange={(enabled) => patch(certificate.id, { enabled })}
                    title="Stop presenting this certificate without deleting it"
                  />
                  <button
                    onClick={() => remove(certificate.id)}
                    className="px-1 text-base leading-none text-muted hover:text-err"
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2">
                  <span className="w-24 flex-none text-[11px] text-muted">
                    Certificate
                  </span>
                  <FileField
                    value={certificate.certPath}
                    placeholder="/path/to/client.pem"
                    title="Choose the client certificate"
                    onChange={(certPath) => patch(certificate.id, { certPath })}
                  />
                </label>
                <label className="flex items-center gap-2">
                  <span className="w-24 flex-none text-[11px] text-muted">
                    Private key
                  </span>
                  <FileField
                    value={certificate.keyPath}
                    placeholder="Leave empty if the key is in the certificate file"
                    title="Choose the private key"
                    onChange={(keyPath) => patch(certificate.id, { keyPath })}
                  />
                </label>
              </div>
            </div>
          ))}

          <button
            onClick={add}
            className="self-start rounded-md border border-edge px-2.5 py-1 text-[11px] text-ink hover:border-brand"
          >
            Add certificate
          </button>
        </div>

        <div className="mt-3 rounded-md border border-edge bg-panel p-2">
          <div className="text-[11px] font-medium text-ink">
            PEM only — converting a .p12 or .pfx
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            Reading <span className="font-mono">.p12</span>/
            <span className="font-mono">.pfx</span> directly would mean linking
            OpenSSL on Linux, which the rest of this app avoids. Convert it once
            instead:
          </p>
          <pre className="mt-1.5 overflow-x-auto rounded border border-edge bg-canvas p-1.5 font-mono text-[10px] leading-relaxed text-muted">
            openssl pkcs12 -in cert.p12 -out client.pem -nodes
          </pre>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            A passphrase-protected key cannot be used either. Decrypt it with{" "}
            <span className="font-mono">
              openssl pkcs8 -topk8 -nocrypt -in key.pem -out decrypted.pem
            </span>
            .
          </p>
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold text-ink">
          Certificate authorities
        </h3>
        <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted">
          Trusted in addition to the system roots, for servers signed by a
          private CA. Use this rather than turning off certificate verification —
          that switch stops checking the identity of every other server too. A
          file holding a chain or bundle is read in full.
        </p>

        <div className="mt-2 flex flex-col gap-1.5">
          {caPaths.length === 0 && (
            <p className="text-[11px] text-muted">
              None added. Only the system roots are trusted.
            </p>
          )}
          {caPaths.map((path, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <FileField
                value={path}
                placeholder="/path/to/ca.pem"
                title="Choose a CA certificate"
                onChange={(next) =>
                  update({
                    caCertificatePaths: caPaths.map((entry, i) =>
                      i === index ? next : entry,
                    ),
                  })
                }
              />
              <button
                onClick={() =>
                  update({
                    caCertificatePaths: caPaths.filter((_, i) => i !== index),
                  })
                }
                className="px-1 text-base leading-none text-muted hover:text-err"
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
          <button
            onClick={() => update({ caCertificatePaths: [...caPaths, ""] })}
            className="self-start rounded-md border border-edge px-2.5 py-1 text-[11px] text-ink hover:border-brand"
          >
            Add CA certificate
          </button>
        </div>
      </section>

      {/* Which certificate a URL would actually get. The matching rules are easy
          to get subtly wrong, and a certificate that silently is not sent looks
          like a server fault. */}
      <section>
        <h3 className="text-xs font-semibold text-ink">Check a URL</h3>
        <div className="mt-1.5 max-w-xl">
          <Input
            value={probe}
            spellCheck={false}
            placeholder="https://api.example.com/v1/orders"
            size="compact"
            onChange={(e) => setProbe(e.target.value)}
            className="font-mono"
          />
        </div>
        {probe.trim() !== "" && (
          <p className="mt-1.5 text-[11px] text-muted">
            {probeHost === "" ? (
              "No host could be read from that URL."
            ) : probeMatch ? (
              <>
                <span className="text-ok">{probeHost}</span> would present{" "}
                <span className="font-mono text-ink">{probeMatch.certPath}</span>{" "}
                (matched by{" "}
                <span className="font-mono">{probeMatch.host}</span>).
              </>
            ) : (
              <>
                <span className="text-ink">{probeHost}</span> matches no
                certificate — the request would go out without one.
              </>
            )}
          </p>
        )}
      </section>
    </div>
  );
}
