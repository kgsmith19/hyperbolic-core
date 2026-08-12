# shim/claude.test.ps1 - control-flow test for the claude launch-cap shim.
# Uses a harmless stand-in exe (never the real claude.exe, never spends
# tokens) via ACC_REAL_CLAUDE_EXE, and forces allow/refuse deterministically
# via lane.total.cap rather than depending on the machine's real process
# count. Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File shim/claude.test.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $here
$sandbox = Join-Path $env:TEMP ("shim-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sandbox | Out-Null

$standIn = Join-Path $sandbox 'stand-in-claude.cmd'
Set-Content -Path $standIn -Value "@echo off`r`necho STAND-IN-RAN`r`nexit /b 7"

$policyPath = Join-Path $sandbox 'policy.json'
$laneDir = Join-Path $sandbox 'lane'

function Set-Cap([int]$cap) {
    $policy = @{ lane = @{ total = @{ cap = $cap; exe = @('C:\definitely-not-a-real-path\claude.exe') } } }
    ($policy | ConvertTo-Json -Depth 5) | Set-Content -Path $policyPath
}

$env:ACC_POLICY = $policyPath
$env:ACC_LANE_DIR = $laneDir
$env:ACC_REAL_CLAUDE_EXE = $standIn

$fail = 0
function Check($name, $cond) { if ($cond) { Write-Host "PASS $name" } else { Write-Host "FAIL $name"; $script:fail = 1 } }

Set-Cap 3
$allowOut = & (Join-Path $repoRoot 'shim\claude.cmd') --version 2>$null
Check 'allow: exit code passes through from the stand-in (7)' ($LASTEXITCODE -eq 7)
Check 'allow: the stand-in actually ran' ($allowOut -match 'STAND-IN-RAN')

Set-Cap 0
# No stderr redirection at all here (not even 2>$null): under
# $ErrorActionPreference='Stop', PS 5.1 wraps ANY redirected stderr from a
# native command into a terminating NativeCommandError, even on a
# deliberate, expected exit 42. The gate's refusal line prints to the
# console instead (harmless) - the assertion below only needs stdout anyway
# (STAND-IN-RAN, if the stand-in ran at all, would be on stdout).
$refuseOut = & (Join-Path $repoRoot 'shim\claude.cmd') -p hi
Check 'refuse: shim exits 42' ($LASTEXITCODE -eq 42)
Check 'refuse: the stand-in never ran' (-not ($refuseOut -match 'STAND-IN-RAN'))

Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
exit $fail
