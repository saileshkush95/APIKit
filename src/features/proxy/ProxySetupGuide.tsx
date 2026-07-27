import { useState } from "react";

type Platform = "macos" | "windows" | "linux" | "android" | "ios";

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: "macos", label: "macOS" },
  { value: "windows", label: "Windows" },
  { value: "linux", label: "Linux" },
  { value: "android", label: "Android" },
  { value: "ios", label: "iOS" },
];

interface Step {
  title: string;
  detail: string;
  code?: string;
}

interface Guide {
  proxy: Step[];
  certificate: Step[];
  note?: string;
}

function guides(host: string, port: number): Record<Platform, Guide> {
  const address = `${host}:${port}`;
  return {
    macos: {
      proxy: [
        {
          title: "System Settings → Network → Details… → Proxies",
          detail:
            "Enable Web Proxy (HTTP) and Secure Web Proxy (HTTPS), then set the server and port.",
        },
        {
          title: "Or set it for one shell only",
          detail: "Applies to curl and most CLI tools without changing system settings.",
          code: `export http_proxy=http://${address}\nexport https_proxy=http://${address}`,
        },
      ],
      certificate: [
        {
          title: "Add the CA to the System keychain",
          detail: "Open the exported .pem in Keychain Access, or run:",
          code: `sudo security add-trusted-cert -d -r trustRoot \\\n  -k /Library/Keychains/System.keychain webrequestkit-ca.pem`,
        },
        {
          title: "Mark it Always Trust",
          detail:
            'Double-click "WebRequestKit CA" → Trust → When using this certificate → Always Trust.',
        },
      ],
      note: "The iOS Simulator uses the Mac keychain, so this covers it too.",
    },
    windows: {
      proxy: [
        {
          title: "Settings → Network & Internet → Proxy",
          detail: `Under Manual proxy setup, enable "Use a proxy server" and enter ${address}.`,
        },
        {
          title: "Or set it for one PowerShell session",
          detail: "Useful for testing a single tool.",
          code: `$env:HTTP_PROXY  = "http://${address}"\n$env:HTTPS_PROXY = "http://${address}"`,
        },
      ],
      certificate: [
        {
          title: "Install into Trusted Root Certification Authorities",
          detail:
            "Double-click the .pem → Install Certificate → Local Machine → place in Trusted Root CAs.",
          code: `certutil -addstore -f "ROOT" webrequestkit-ca.pem`,
        },
      ],
    },
    linux: {
      proxy: [
        {
          title: "GNOME: Settings → Network → Network Proxy → Manual",
          detail: `Set HTTP and HTTPS to ${host} on port ${port}.`,
        },
        {
          title: "Or export it in a shell",
          detail: "Respected by curl, wget and most CLI tooling.",
          code: `export http_proxy=http://${address}\nexport https_proxy=http://${address}`,
        },
      ],
      certificate: [
        {
          title: "Debian / Ubuntu",
          detail: "Copy the certificate into the system anchors and refresh.",
          code: `sudo cp webrequestkit-ca.pem /usr/local/share/ca-certificates/webrequestkit.crt\nsudo update-ca-certificates`,
        },
        {
          title: "Fedora / RHEL",
          detail: "Same idea, different anchor directory.",
          code: `sudo cp webrequestkit-ca.pem /etc/pki/ca-trust/source/anchors/\nsudo update-ca-trust`,
        },
        {
          title: "Browsers keep their own stores",
          detail:
            "Import the CA in Firefox/Chrome under Certificates → Authorities as well.",
        },
      ],
    },
    android: {
      proxy: [
        {
          title: "Wi-Fi → long-press network → Modify network",
          detail: `Advanced options → Proxy → Manual → hostname ${host}, port ${port}.`,
        },
        {
          title: "Emulator",
          detail:
            "Use 10.0.2.2 for this machine, or launch with a proxy flag:",
          code: `emulator -avd <name> -http-proxy http://10.0.2.2:${port}`,
        },
      ],
      certificate: [
        {
          title: "Install the CA",
          detail:
            "Transfer the .pem (rename to .crt if needed) → Settings → Security → Encryption & credentials → Install a certificate → CA certificate.",
        },
        {
          title: "Android 7+ : apps must opt in to user CAs",
          detail:
            "Your own debug builds can trust user certificates with a network security config:",
          code: `<network-security-config>\n  <debug-overrides>\n    <trust-anchors>\n      <certificates src="user" />\n      <certificates src="system" />\n    </trust-anchors>\n  </debug-overrides>\n</network-security-config>`,
        },
      ],
      note: "Third-party apps you did not build cannot be intercepted this way — that is by design.",
    },
    ios: {
      proxy: [
        {
          title: "Settings → Wi-Fi → ⓘ → Configure Proxy → Manual",
          detail: `Server ${host}, port ${port}, then Save.`,
        },
      ],
      certificate: [
        {
          title: "Install the profile",
          detail:
            "AirDrop or download the .pem on the device, then Settings → Profile Downloaded → Install.",
        },
        {
          title: "Enable full trust (required)",
          detail:
            "Settings → General → About → Certificate Trust Settings → enable WebRequestKit CA. HTTPS keeps failing until this is done.",
        },
      ],
    },
  };
}

/** In-app version of docs/proxy-setup.md, filled in with the live address. */
export function ProxySetupGuide({
  host,
  port,
}: {
  host: string;
  port: number;
}) {
  const [platform, setPlatform] = useState<Platform>("macos");
  const guide = guides(host, port)[platform];

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-none items-center gap-1 border-b border-edge px-3 py-2">
        {PLATFORMS.map((option) => (
          <button
            key={option.value}
            onClick={() => setPlatform(option.value)}
            className={`rounded-md px-3 py-1 text-xs ${
              platform === option.value
                ? "bg-elevated font-medium text-ink"
                : "text-muted hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        ))}
        <span className="ml-auto font-mono text-[11px] text-muted">
          {host}:{port}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <p className="mb-4 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
          Only intercept devices and networks you own or are authorised to test.
          Remove the CA certificate when you are finished — a trusted CA left
          installed is a real risk to that device.
        </p>

        {(
          [
            ["1. Point the device at the proxy", guide.proxy],
            ["2. Trust the CA certificate (needed for HTTPS)", guide.certificate],
          ] as const
        ).map(([heading, steps]) => (
          <div key={heading} className="mb-5">
            <h3 className="mb-2 text-xs font-semibold text-ink">{heading}</h3>
            <ol className="flex flex-col gap-2.5">
              {steps.map((step, i) => (
                <li key={i} className="text-xs leading-relaxed">
                  <div className="text-ink">{step.title}</div>
                  <div className="text-muted">{step.detail}</div>
                  {step.code && (
                    <pre className="mt-1 overflow-auto rounded border border-edge bg-panel p-2 font-mono text-[11px] leading-relaxed whitespace-pre">
                      {step.code}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          </div>
        ))}

        {guide.note && (
          <p className="text-[11px] text-muted">{guide.note}</p>
        )}

        <div className="mt-5 border-t border-edge pt-3">
          <h3 className="mb-1 text-xs font-semibold text-ink">Verify</h3>
          <pre className="overflow-auto rounded border border-edge bg-panel p-2 font-mono text-[11px]">
            {`curl -x http://${host}:${port} https://example.com -sI | head -1`}
          </pre>
          <p className="mt-2 text-[11px] text-muted">
            The request should appear in the flow list. If HTTPS fails while HTTP
            works, the CA is not trusted on that client yet.
          </p>
        </div>
      </div>
    </div>
  );
}
