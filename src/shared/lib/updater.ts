// Auto-update via the Tauri updater plugin.
//
// Releases are published on GitHub by CI; `latest.json` on the latest release
// is the update feed. Packages are signed with a local minisign key (free —
// unrelated to OS code signing), and the plugin verifies the signature against
// the public key in tauri.conf.json before installing anything.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { notify } from "./notify";

let installing = false;

/**
 * Checks for a newer version and offers to install it. Quiet when nothing is
 * available; `report` also surfaces "up to date" / errors, for the explicit
 * Settings button.
 */
export async function checkForUpdate(report = false): Promise<void> {
  if (installing) return;

  let update: Update | null;
  try {
    update = await check();
  } catch (e) {
    if (report) notify("error", "Could not check for updates", { detail: e });
    return;
  }

  if (!update) {
    if (report) notify("success", "APIKit is up to date");
    return;
  }

  notify("info", `APIKit ${update.version} is available`, {
    detail: update.body || undefined,
    timeoutMs: 0,
    action: { label: "Install and restart", run: () => install(update) },
  });
}

async function install(update: Update): Promise<void> {
  if (installing) return;
  installing = true;
  notify("info", "Downloading update… APIKit will restart when it is ready.", {
    timeoutMs: 0,
  });
  try {
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    installing = false;
    notify("error", "Update failed", { detail: e });
  }
}
