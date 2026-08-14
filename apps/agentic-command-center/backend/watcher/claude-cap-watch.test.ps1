# watcher/claude-cap-watch.test.ps1 - unit tests for Get-CapDecision (pure;
# no CIM call, no file I/O, no scheduled task). Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File watcher/claude-cap-watch.test.ps1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'claude-cap-watch.ps1')

$fail = 0
function Check($name, $cond) { if ($cond) { Write-Host "PASS $name" } else { Write-Host "FAIL $name"; $script:fail = 1 } }

$one = @([pscustomobject]@{ ExecutablePath = 'C:\real\claude.exe' })
$four = @(1..4 | ForEach-Object { [pscustomobject]@{ ExecutablePath = 'C:\real\claude.exe' } })

$d1 = Get-CapDecision -Cap 3 -ExePaths @('C:\real\claude.exe') -Processes $one -ShimOnPath $true -ShimFileExists $true -RealExeExists $true
Check 'under cap, healthy shim -> no alert' (-not $d1.Alert -and -not $d1.Breach -and -not $d1.FailOpen)

$d2 = Get-CapDecision -Cap 3 -ExePaths @('C:\real\claude.exe') -Processes $four -ShimOnPath $true -ShimFileExists $true -RealExeExists $true
Check 'over cap -> breach alert' ($d2.Breach -and $d2.Alert -and $d2.Count -eq 4)

$d3 = Get-CapDecision -Cap 3 -ExePaths @('C:\real\claude.exe') -Processes $one -ShimOnPath $false -ShimFileExists $true -RealExeExists $true
Check 'shim missing from PATH -> fail-open alert, not a breach' ($d3.FailOpen -and $d3.Alert -and -not $d3.Breach)

$d4 = Get-CapDecision -Cap 3 -ExePaths @('C:\real\claude.exe') -Processes $one -ShimOnPath $true -ShimFileExists $false -RealExeExists $true
Check 'shim file missing -> fail-open alert' ($d4.FailOpen -and $d4.Alert)

$d5 = Get-CapDecision -Cap 3 -ExePaths @('C:\real\claude.exe') -Processes $one -ShimOnPath $true -ShimFileExists $true -RealExeExists $false
Check 'real exe missing on disk -> fail-open alert' ($d5.FailOpen -and $d5.Alert)

$d6 = Get-CapDecision -Cap 3 -ExePaths @('C:\other\claude.exe') -Processes $four -ShimOnPath $true -ShimFileExists $true -RealExeExists $true
Check 'processes at an unconfigured path are never counted' (-not $d6.Breach -and $d6.Count -eq 0)

# cap:0 is a deliberate lockdown (design doc §3: refuses ALL session
# launches). Its healthy, correctly-enforced steady state is zero live
# processes - that is NOT a breach (breach means the count EXCEEDS the cap,
# per the design doc's own wording; a gate correctly enforcing cap:0 never
# lets count rise above 0 in the first place). Anything above zero under
# cap:0 means something got past the gate, which IS a breach.
$d7 = Get-CapDecision -Cap 0 -ExePaths @('C:\real\claude.exe') -Processes @() -ShimOnPath $true -ShimFileExists $true -RealExeExists $true
Check 'cap:0 lockdown with zero live processes is healthy, not a breach' (-not $d7.Breach -and -not $d7.Alert)

$d8 = Get-CapDecision -Cap 0 -ExePaths @('C:\real\claude.exe') -Processes $one -ShimOnPath $true -ShimFileExists $true -RealExeExists $true
Check 'cap:0 lockdown breaches the moment anything is actually running' ($d8.Breach -and $d8.Alert)

exit $fail
