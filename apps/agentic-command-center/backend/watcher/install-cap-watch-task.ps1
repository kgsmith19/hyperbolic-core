# watcher/install-cap-watch-task.ps1 - registers (or re-registers) the
# ACC-ClaudeCapWatch Scheduled Task that runs watcher\claude-cap-watch.ps1
# every 60 seconds. Idempotent (-Force), self-elevates if needed.
#
# This is the CANONICAL definition of that task. It used to live only in
# runbox/install-claude-cap-gate.ps1, which is gitignored and was auto-archived
# into runbox/.trash once it succeeded (guards OI-025) - so the definition of a
# task running on Kyle's machine every minute survived nowhere runnable. It
# lives here now, tracked and unit-tested (install-cap-watch-task.test.ps1).
#
# Does NOT touch the PATH shim half of the old installer; that half succeeded
# and is idempotent where it lives.
$ErrorActionPreference = 'Stop'

# Pure - builds the task spec and nothing else, so the test can assert on it
# without registering anything. Everything below the dot-source guard is I/O.
function Get-CapWatchTaskSpec {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $scriptPath = Join-Path $RepoRoot 'watcher\claude-cap-watch.ps1'
    [pscustomobject]@{
        TaskName = 'ACC-ClaudeCapWatch'
        Execute  = 'powershell.exe'
        # -WindowStyle Hidden is load-bearing. This action runs in Kyle's
        # INTERACTIVE session on purpose (claude-cap-watch.ps1 raises a WinForms
        # balloon on alert, which a session-0 task could never put on his
        # desktop), and an interactive console app without it flashes a real
        # console window every single repetition. Measured 2026-08-04 with
        # EnumWindows polling from t=0: without it a window is visible from
        # ~213ms until the process exits; with it, never visible at all. That
        # flash-once-a-minute is exactly what Kyle reported. Do not remove.
        Argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
        RepetitionInterval = New-TimeSpan -Seconds 60
        # Finite on purpose: [TimeSpan]::MaxValue serialises to an ISO8601
        # duration ("P99999999DT23H59M59S") that Task Scheduler's XML rejects,
        # failing the whole registration (guards OI-025, twice).
        RepetitionDuration = New-TimeSpan -Days 3650
        ScriptPath = $scriptPath
    }
}

# Dot-sourced by the test -> functions only, no registration, no elevation.
if ($MyInvocation.InvocationName -eq '.') { return }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $here
$spec = Get-CapWatchTaskSpec -RepoRoot $repoRoot
if (-not (Test-Path $spec.ScriptPath)) { throw "missing $($spec.ScriptPath)" }

# Task registration is admin-gated on this machine. Per AGENTS.md's runbox
# rule, approval to run this script IS approval to elevate: relaunch once,
# propagate the child's exit code, never silently continue unelevated.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host 'Not elevated - relaunching via UAC to register the scheduled task...'
    $child = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $MyInvocation.MyCommand.Path)
    exit $child.ExitCode
}

$action = New-ScheduledTaskAction -Execute $spec.Execute -Argument $spec.Argument
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
            -RepetitionInterval $spec.RepetitionInterval -RepetitionDuration $spec.RepetitionDuration
$atLogon = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -MultipleInstances IgnoreNew
# Interactive: see the -WindowStyle comment above. The balloon needs the desktop.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
               -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $spec.TaskName -Action $action -Trigger @($repeat, $atLogon) `
    -Settings $settings -Principal $principal `
    -Description 'ACC claude launch-cap health check, alert-only (C:\code\guards\watcher\claude-cap-watch.ps1)' `
    -Force | Out-Null

# Prove it landed the way we asked, rather than trusting a clean exit code.
$live = Get-ScheduledTask -TaskName $spec.TaskName
$liveArgs = $live.Actions.Arguments
Write-Host "registered: $($spec.TaskName) [$($live.State)]"
Write-Host "arguments : $liveArgs"
if ($liveArgs -notmatch '-WindowStyle\s+Hidden') {
    Write-Error 'registered task is MISSING -WindowStyle Hidden - it will still flash a console window'
    exit 1
}
Write-Host 'verified  : -WindowStyle Hidden is set; no console window will appear.'
