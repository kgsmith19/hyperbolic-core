// notify.mjs — one native OS notification, fire-and-forget. Windows-only
// today (this repo runs on Kyle's Windows machine); everywhere else this is
// a silent no-op. Never blocks or throws: a broken notification must never
// cost a hook its exit, the same fail-open contract every hook here keeps.
import { spawn } from "node:child_process";

// PowerShell single-quoted strings don't interpolate — doubling an internal
// quote is the only escaping a single-quoted literal needs, so this is safe
// against anything a directive's own text could contain.
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// A NotifyIcon balloon tip, not a WinRT toast: a toast needs an
// AppUserModelID registered with the shell or it frequently shows nothing at
// all on Windows 10/11, while a NotifyIcon balloon has worked unregistered
// since XP — the boring, reliable choice over the modern-looking fragile one.
export function notifyArgs(title, body) {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$n = New-Object System.Windows.Forms.NotifyIcon;",
    "$n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true;",
    `$n.ShowBalloonTip(5000, ${psQuote(title)}, ${psQuote(body)}, 'Info');`,
    "Start-Sleep -Seconds 6; $n.Dispose()",
  ].join(" ");
  return ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script];
}

// platform/spawnFn are injectable (same seam shape as runner.mjs's killTree
// and cmdline.mjs's spawnSpec) so this is unit-testable without a real
// Windows box or a real subprocess.
export function notify(title, body, { platform = process.platform, spawnFn = spawn } = {}) {
  if (platform !== "win32") return;
  try {
    spawnFn("powershell.exe", notifyArgs(title, body), { detached: true, stdio: "ignore" }).unref();
  } catch {}
}
