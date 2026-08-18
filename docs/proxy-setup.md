# Proxy setup guide

APIKit's proxy intercepts HTTP and HTTPS traffic from any device that can
reach this machine. HTTPS interception works by re-signing traffic with a CA
certificate that APIKit generates on first run — so every client needs two
things:

1. **Proxy configured** → this machine's IP and the proxy port (default `8080`).
2. **CA certificate installed and trusted** → otherwise HTTPS sites fail to load.

Start the proxy from the **Proxy** tab. On a phone or another machine, point it
at the proxy and then open **`http://apikit.setup`** — the proxy serves its own
certificate there, so no file server, cable, or extra tool is involved. On this
computer, **Export CA certificate** gives you the `.pem` directly (its path is
shown next to the button).

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

### 0. Prerequisites

The phone and this computer must be on the **same Wi-Fi network**, and the proxy
must be running (it listens on the LAN automatically). The Proxy tab's status
line shows the address to use, e.g. `192.168.1.5:8080` — that IP is what the
phone needs; `127.0.0.1` means "the phone itself" and will never work.

If nothing arrives later, a firewall on this computer is the usual cause. On
macOS: System Settings → Network → Firewall → Options → allow APIKit.

### 1. Point the phone at the proxy

1. Settings → **Network & internet** → Internet → tap the ⚙ beside your network.
   (Older versions: Settings → Wi-Fi → long-press the network → *Modify network*.)
2. **Advanced options** → Proxy → **Manual**.
3. Proxy hostname = this computer's IP, Proxy port = `8080` → **Save**.

Leave "Bypass proxy for" empty while testing.

### 2. Get the certificate onto the phone

Open **`http://apikit.setup`** in the phone's browser. The proxy answers that
hostname itself and hands over its own certificate — no file server, no cable,
and nothing extra installed on the computer. The download starts on its own.

Type the `http://` part. Without it, browsers treat `apikit.setup` as a search
term rather than an address.

If the phone is not pointed at the proxy yet, browse to the proxy's own address
instead — `http://<computer-ip>:8080/` — which serves the same page. That also
covers the case where a browser insists on searching for the name.

### 3. Install it as a CA

Settings → **Security & privacy** → More security settings → **Encryption &
credentials** → *Install a certificate* → **CA certificate** → *Install anyway*
(confirming the warning) → pick `apikit-ca.crt` from **Downloads**.

The setup page has a button that jumps straight to security settings, and shows
the certificate's SHA-256 so you can check it is the one APIKit is using.

Android 11 and later deliberately refuse to let a web page install a CA on your
behalf, so this trip through Settings cannot be automated away — downloading the
file is as far as any tool can take it. The exact path varies by manufacturer;
searching Settings for "certificate" finds it on every device. Success looks
like a persistent "Network may be monitored" notice — that is expected while the
CA is installed.

### 4. Android 7+ : apps must opt in to user CAs

This is the step that surprises people. Since Android 7, apps **ignore
user-installed CAs by default**, so a correctly installed certificate still
produces SSL errors in most apps (Chrome and other browsers do honour it).

For an app you build yourself, add a network security config:

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

and reference it from the manifest:

```xml
<application android:networkSecurityConfig="@xml/network_security_config">
```

`debug-overrides` applies only to debuggable builds, so release builds stay
strict. Third-party apps you did not build cannot be intercepted this way —
that is by design, not a bug in APIKit.

### Emulator — the one case that can be fully automated

The emulator reaches the host at **`10.0.2.2`**, not the LAN IP:

```sh
emulator -avd <name> -http-proxy http://10.0.2.2:8080
```

An emulator image *without* Play Store has a writable system partition, so the
CA can go into the **system** store — where even apps that ignore user CAs will
trust it, with no `network_security_config` and no tapping through Settings:

```sh
curl -o apikit-ca.pem http://10.0.2.2:8080/apikit-ca.pem
# Android looks up CA files by a hash of the subject, not by name
hash=$(openssl x509 -inform PEM -subject_hash_old -in apikit-ca.pem -noout)
adb root && adb remount
adb push apikit-ca.pem /system/etc/security/cacerts/$hash.0
adb shell chmod 644 /system/etc/security/cacerts/$hash.0
adb reboot
```

A cold boot or wipe removes it again. On a Play Store image `adb remount` fails
and there is no way in — use a Google APIs image instead.

For a physical device, `adb push apikit-ca.pem /sdcard/Download/` saves the
browser step, but the install itself still has to happen in Settings.

---

## iOS / iPadOS

### 0. Prerequisites

Same Wi-Fi network as this computer, proxy running, and use the LAN address
shown in the Proxy tab (e.g. `192.168.1.5:8080`).

### 1. Point the device at the proxy

1. Settings → **Wi-Fi** → tap the ⓘ beside the connected network.
2. Scroll down → **Configure Proxy** → **Manual**.
3. Server = this computer's IP, Port = `8080`. Leave Authentication off.
4. **Save** (top right) — it is easy to miss, and nothing applies without it.

### 2. Download the certificate

With the proxy now configured, open **Safari** (this must be Safari — Chrome
cannot install profiles) and go to:

```
http://<computer-ip>:8080/
```

The proxy serves its own certificate there, so nothing has to be running on the
computer. iOS will say "Profile Downloaded".

`http://apikit.setup` reaches the same page, but prefer the address form on
iOS: Safari rewrites typed hostnames to HTTPS, and nothing here can be served
over HTTPS — the certificate that would sign it is the one you are collecting.
The proxy refuses that tunnel so Safari drops back to HTTP, but an IP with an
explicit port skips the round trip entirely.

### 3. Install the profile

Settings → **Profile Downloaded** (near the top, just under your name) →
**Install** → enter your passcode → Install → Install. If that banner is
missing: Settings → General → VPN & Device Management → find the profile there.

### 4. Enable full trust — the step everyone misses

Settings → General → **About** → scroll to the bottom → **Certificate Trust
Settings** → turn the switch **on** for "APIKit CA" → Continue.

Until this switch is on, the certificate is installed but not trusted, and
**every HTTPS request still fails**. If your app shows SSL errors after
installing the profile, this is almost always why.

### Simulator

The iOS Simulator uses the Mac's own network settings and keychain, so trusting
the CA on macOS (above) covers it — no proxy configuration inside the simulator.
To be certain, drag the `.pem` onto the running simulator window and it will be
installed there too.

### Turning it off

Remove the proxy (Configure Proxy → Off) and delete the certificate: Settings →
General → VPN & Device Management → the profile → **Remove Profile**. Leaving a
trusted CA installed on a phone is a real security risk.

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
