# watcher/claude-cap-watch.ps1 - one-shot claude launch-cap health check.
# Alert-only: NEVER kills a process. Invoked repeatedly by a Scheduled Task
# (60s repetition, registered by watcher/install-cap-watch-task.ps1) rather
# than looping itself - Task Scheduler already owns repetition, so this
# script does exactly one check and exits. Standalone by design: imports no
# repo code, so a bug in hooks/lane.mjs or the shim cannot also break the
# thing meant to detect that bug. Design:
# docs/adr/ADR-0003-launch-cap-check-then-launch.md
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $here

# Pure decision logic - no file/process I/O, fully unit-testable by dot-
# sourcing this script (see claude-cap-watch.test.ps1).
function Get-CapDecision {
    param(
        [int]$Cap,
        [string[]]$ExePaths,
        [array]$Processes,
        [bool]$ShimOnPath,
        [bool]$ShimFileExists,
        [bool]$RealExeExists
    )
    $wanted = @($ExePaths | ForEach-Object { $_.ToLowerInvariant() })
    $matched = @($Processes | Where-Object { $_.ExecutablePath -and ($wanted -contains $_.ExecutablePath.ToLowerInvariant()) })
    $breach = $matched.Count -gt $Cap
    $failOpen = (-not $ShimOnPath) -or (-not $ShimFileExists) -or (-not $RealExeExists)
    [pscustomobject]@{
        Count    = $matched.Count
        Cap      = $Cap
        Breach   = $breach
        FailOpen = $failOpen
        Alert    = ($breach -or $failOpen)
    }
}

# Dot-sourced (by the test) -> stop here, functions only, no real run.
if ($MyInvocation.InvocationName -eq '.') { return }

$policyPath = if ($env:ACC_POLICY) { $env:ACC_POLICY } else { Join-Path $repoRoot 'policy.json' }
$stateFile = Join-Path $here 'claude-cap-watch.state.json'
$logFile = Join-Path $here 'claude-cap-watch.log'

$policy = Get-Content $policyPath -Raw | ConvertFrom-Json
$cap = $policy.lane.total.cap
$exePaths = @($policy.lane.total.exe)

$shimDir = Join-Path $repoRoot 'shim'
$shimOnPath = @(($env:Path -split ';') | Where-Object { $_ -eq $shimDir }).Count -gt 0
$shimFileExists = Test-Path (Join-Path $shimDir 'claude.cmd')
$realExeExists = ($exePaths.Count -gt 0) -and (Test-Path $exePaths[0])

$procs = Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Select-Object ProcessId, ExecutablePath, CreationDate

$decision = Get-CapDecision -Cap $cap -ExePaths $exePaths -Processes $procs `
    -ShimOnPath $shimOnPath -ShimFileExists $shimFileExists -RealExeExists $realExeExists

$prevAlert = $false
if (Test-Path $stateFile) {
    try { $prevAlert = [bool](Get-Content $stateFile -Raw | ConvertFrom-Json).Alert } catch { $prevAlert = $false }
}

if ($decision.Alert -and -not $prevAlert) {
    $msg = if ($decision.Breach) {
        "claude launch cap BREACH: $($decision.Count)/$($decision.Cap) claude.exe running"
    } else {
        "claude launch cap gate is silently fail-open (shim missing from PATH or misconfigured)"
    }
    Add-Content -Path $logFile -Value "$(Get-Date -Format o) ALERT $msg"
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $ni = New-Object System.Windows.Forms.NotifyIcon
        $ni.Icon = [System.Drawing.SystemIcons]::Warning
        $ni.Visible = $true
        $ni.ShowBalloonTip(10000, 'ACC claude launch cap', $msg, [System.Windows.Forms.ToolTipIcon]::Warning)
        Start-Sleep -Milliseconds 500
        $ni.Dispose()
    } catch {
        # Best-effort only - a headless/no-session context (or missing
        # WinForms) must never make this script fail; the log line above is
        # the durable record either way.
    }
} elseif (-not $decision.Alert -and $prevAlert) {
    Add-Content -Path $logFile -Value "$(Get-Date -Format o) CLEARED"
}

$decision | ConvertTo-Json | Set-Content -Path $stateFile
