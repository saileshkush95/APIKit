# Proxy setup guide

APIKit's proxy intercepts HTTP and HTTPS traffic from any device that can
reach this machine. HTTPS interception works by re-signing traffic with a CA
certificate that APIKit generates on first run — so every client needs two
things:

1. **Proxy configured** → this machine's IP and the proxy port (default `8080`).
2. **CA certificate installed and trusted** → otherwise HTTPS sites fail to load.

Start the proxy from the **Proxy** tab, then use **Export CA certificate** to get
the `.pem` file (its path is shown next to the button).

> Only intercept traffic on devices and networks you own or are authorised to
> test. Remove the CA certificate when you are done — a trusted CA that anyone
> else can use to sign certificates is a real risk to that device.

## Find this machine's address

The proxy binds to all interfaces, so clients on the same network connect to your
LAN IP:

- **macOS/Linux:** `ipconfig getifaddr en0` or `ip addr show`
- **Windows:** `ipconfig` → *IPv4 Address*

Use `127.0.0.1` only for clients running on this same machine.

---

## macOS

**Proxy**

1. System Settings → Network → your active connection → **Details… → Proxies**.
2. Enable **Web Proxy (HTTP)** and **Secure Web Proxy (HTTPS)**.
3. Server = the machine IP, Port = `8080`. Click OK → Apply.

Or per-shell, without changing system settings:

```sh
export http_proxy=http://127.0.0.1:8080
export https_proxy=http://127.0.0.1:8080
```

**Certificate**

1. Open the exported `.pem` — Keychain Access opens.
2. Add it to the **System** (or **login**) keychain.
3. Find "APIKit CA" → double-click → **Trust** → *When using this
   certificate* → **Always Trust**. Close and authenticate.

CLI equivalent:

```sh
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ~/Downloads/apikit-ca.pem
```

---

## Windows

**Proxy**

1. Settings → Network & Internet → **Proxy**.
2. Under *Manual proxy setup*, turn on **Use a proxy server**.
3. Address = machine IP, Port = `8080` → Save.

Per-shell:

```powershell
$env:HTTP_PROXY  = "http://127.0.0.1:8080"
$env:HTTPS_PROXY = "http://127.0.0.1:8080"
```

**Certificate**

1. Double-click the `.pem` → **Install Certificate**.
2. Store location: **Local Machine** → *Place all certificates in the following
   store* → **Trusted Root Certification Authorities** → Finish.

CLI equivalent (elevated):

```powershell
certutil -addstore -f "ROOT" apikit-ca.pem
```

---

## Linux

**Proxy**

GNOME: Settings → Network → Network Proxy → **Manual**, set HTTP and HTTPS to the
machine IP and port `8080`.

Per-shell (works for `curl`, most CLIs):

```sh
export http_proxy=http://127.0.0.1:8080
export https_proxy=http://127.0.0.1:8080
```

**Certificate**

Debian/Ubuntu:

```sh
sudo cp apikit-ca.pem /usr/local/share/ca-certificates/apikit.crt
sudo update-ca-certificates
```

Fedora/RHEL:

```sh
sudo cp apikit-ca.pem /etc/pki/ca-trust/source/anchors/
sudo update-ca-trust
```

Firefox and Chrome keep their own stores — import the certificate under
*Settings → Privacy & Security → Certificates → Authorities* as well.

---

## Android

**Proxy**

1. Settings → Wi-Fi → long-press your network → **Modify network**.
2. Advanced options → Proxy → **Manual**.
3. Hostname = machine IP, Port = `8080` → Save.

**Certificate**

1. Transfer the `.pem` to the device (rename to `.crt` if the installer ignores
   it), or serve it over HTTP and download it in the browser.
2. Settings → Security → **Encryption & credentials** → *Install a certificate*
   → **CA certificate** → confirm the warning → select the file.

**Android 7+ caveat:** apps only trust user-installed CAs if their network
security config opts in. Your own debug builds can allow it with:

```xml
<!-- res/xml/network_security_config.xml -->
<network-security-config>
  <debug-overrides>
    <trust-anchors>
      <certificates src="user" />
      <certificates src="system" />
    </trust-anchors>
  </debug-overrides>
</network-security-config>
```

Reference it from the manifest's `<application
android:networkSecurityConfig="@xml/network_security_config">`. Third-party apps
you do not build cannot be intercepted this way — that is by design.

Emulators: use `10.0.2.2` for the host machine, or start with
`emulator -avd <name> -http-proxy http://10.0.2.2:8080`.

---

## iOS / iPadOS

**Proxy**

1. Settings → Wi-Fi → tap the ⓘ next to your network.
2. **Configure Proxy → Manual**.
3. Server = machine IP, Port = `8080` → Save.

**Certificate**

1. Serve or AirDrop the `.pem` to the device and open it in Safari.
2. Settings → **Profile Downloaded** → Install.
3. **Then trust it explicitly:** Settings → General → About → **Certificate Trust
   Settings** → enable full trust for "APIKit CA".

Step 3 is required — without it every HTTPS request still fails.

Simulators trust the Mac's system keychain, so installing the CA on macOS (above)
covers the iOS Simulator too.

---

## Verifying

With the proxy running and a client configured:

```sh
curl -x http://127.0.0.1:8080 https://example.com -sI | head -1
```

The request should appear in the **Proxy** tab's flow list. If HTTPS requests
fail but HTTP works, the CA certificate is not trusted on that client.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Nothing appears in the flow list | Client not pointed at this machine's IP, or a firewall is blocking the port |
| HTTPS fails, HTTP works | CA not installed, or installed but not trusted (iOS step 3, macOS "Always Trust") |
| Works in browser, not in an app | App pins certificates or ignores user CAs (Android 7+) |
| Port already in use | Another process holds `8080` — change the port in the Proxy tab |
