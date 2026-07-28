// Email notifications for monitors.
//
// SMTP settings live in AppSettings; the password lives in the OS keychain and
// is fetched right before each send, so it is never held in app state.

import { secretGet, sendEmail, smtpCheck, type SmtpSpec } from "./api";
import type { AppSettings, Monitor, MonitorRun } from "../types";

export const SMTP_PASSWORD_KEY = "smtpPassword";

/** The From address: explicit if set, otherwise the username doubles as it. */
export function smtpSender(settings: AppSettings): string {
  return settings.smtpFrom.trim() || settings.smtpUsername.trim();
}

/** Only the host is mandatory — plus *some* address to put in From. */
export function smtpConfigured(settings: AppSettings): boolean {
  return settings.smtpHost.trim() !== "" && smtpSender(settings) !== "";
}

async function smtpSpec(settings: AppSettings): Promise<SmtpSpec> {
  return {
    host: settings.smtpHost,
    port: settings.smtpPort,
    username: settings.smtpUsername,
    password: await secretGet(SMTP_PASSWORD_KEY).catch(() => ""),
    security: settings.smtpSecurity,
    from: smtpSender(settings),
    fromName: settings.smtpFromName,
  };
}

/** A monitor's own recipients, or the global default list when it has none. */
export function monitorRecipients(
  settings: AppSettings,
  monitor: Monitor,
): string {
  return monitor.emailTo?.trim() || settings.smtpDefaultTo.trim();
}

/** Verifies host/credentials by talking to the server, without sending mail. */
export async function verifySmtp(settings: AppSettings): Promise<void> {
  await smtpCheck(await smtpSpec(settings));
}

/** Sends a test message so SMTP settings can be verified before relying on them. */
export async function sendTestEmail(
  settings: AppSettings,
  to: string,
): Promise<void> {
  await sendEmail(
    await smtpSpec(settings),
    to,
    "APIKit test email",
    "This is a test message from APIKit.\n\nIf you are reading it, your SMTP settings work.",
  );
}

/**
 * The failure/recovery message for a monitor run. Exposed for the send below;
 * plain text on purpose — it must survive every mail client.
 */
function monitorMessage(
  monitor: Monitor,
  run: MonitorRun,
  streak: number,
): string {
  const status = run.ok ? "recovered" : "failing";
  return [
    `Monitor: ${monitor.name}`,
    `Status: ${status}`,
    ...(run.ok ? [] : [`Consecutive failed checks: ${streak}`]),
    `Checked: ${new Date(run.atMs).toLocaleString()}`,
    `Requests: ${run.requests} (${run.failures} failed)`,
    `Average time: ${Math.round(run.avgMs)}ms`,
    "",
    run.detail,
    "",
    "— APIKit monitors",
  ].join("\n");
}

/**
 * Emails a monitor transition. Failures inside the send are reported to the
 * caller's catch — a broken mail server must not break the monitor run.
 */
export async function sendMonitorEmail(
  settings: AppSettings,
  monitor: Monitor,
  run: MonitorRun,
  streak: number,
): Promise<void> {
  const subject = run.ok
    ? `✅ ${monitor.name} recovered`
    : `🔴 ${monitor.name} is failing`;
  await sendEmail(
    await smtpSpec(settings),
    monitorRecipients(settings, monitor),
    subject,
    monitorMessage(monitor, run, streak),
  );
}
