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
# Supply the process list instead of letting gate() run a live WMI query.
# This is CONTROL-FLOW test, not a test of the query: with cap 0 any
# successful count refuses, so the query's only influence on the outcome is
# whether it throws -- and on a loaded runner Get-CimInstance Win32_Process
# did exactly that, gate() failed open by design, and both refuse assertions
# below failed while the identical code passed on a faster runner (#222).
# The real CIM query keeps its own coverage in hooks/lane.test.mjs.
$env:ACC_LANE_PROCESS_FIXTURE = '[]'

$fail = 0
function Check($name, $cond) { if ($cond) { Write-Host "PASS $name" } else { Write-Host "FAIL $name"; $script:fail = 1 } }

Set-Cap 3
# Deliberately the SAME arguments as the refuse case below, so the only
# difference between allow and refuse is the cap. `--version` here would be a
# UTILITY_ARGS bypass in lane.mjs (gate() returns ok before it ever reads the
# cap), which would let this pass with the cap completely broken.
$allowOut = & (Join-Path $repoRoot 'shim\claude.cmd') -p hi 2>$null
Check 'allow: exit code passes through from the stand-in (7)' ($LASTEXITCODE -eq 7)
Check 'allow: the stand-in actually ran' ($allowOut -match 'STAND-IN-RAN')

# Default resolution (#352): with no explicit override the shim must derive
# its executable from the RUNNING user's profile, not a path baked in on one
# developer's machine. Proven against a synthetic USERPROFILE holding an
# empty .local\bin and no claude.exe: cmd then reports the exact command
# line it could not start, so its message names the path the shim resolved,
# which is the assertion. (The directory has to exist -- without it cmd
# reports "cannot find the path specified" and names nothing.) The
# surrounding sentence is localized; the path inside it is not. Nothing
# executable is created there, so this can never reach a real claude.exe.
$syntheticProfile = Join-Path $sandbox 'synthetic-profile'
New-Item -ItemType Directory -Path (Join-Path $syntheticProfile '.local\bin') | Out-Null
$expectedDefault = Join-Path $syntheticProfile '.local\bin\claude.exe'
$savedProfile = $env:USERPROFILE
$env:USERPROFILE = $syntheticProfile
Remove-Item Env:\ACC_REAL_CLAUDE_EXE
# 'Continue' for this one call: under 'Stop', PS 5.1 wraps the redirected
# stderr below into a terminating NativeCommandError -- the same hazard the
# refuse case documents, except here the stderr IS the evidence.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$defaultOut = & (Join-Path $repoRoot 'shim\claude.cmd') -p hi 2>&1 | Out-String
$ErrorActionPreference = $prevEap
$env:USERPROFILE = $savedProfile
$env:ACC_REAL_CLAUDE_EXE = $standIn
Check 'default: resolves %USERPROFILE%\.local\bin\claude.exe' ($defaultOut -match [regex]::Escape($expectedDefault))
Check 'default: no stand-in ran, so the path above is the default and not an override' (-not ($defaultOut -match 'STAND-IN-RAN'))

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
