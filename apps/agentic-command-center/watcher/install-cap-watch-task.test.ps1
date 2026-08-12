# watcher/install-cap-watch-task.test.ps1 - unit tests for the ACC-ClaudeCapWatch
# task spec (pure; registers nothing, touches no machine state). Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File watcher/install-cap-watch-task.test.ps1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-cap-watch-task.ps1')

$fail = 0
function Check($name, $cond) { if ($cond) { Write-Host "PASS $name" } else { Write-Host "FAIL $name"; $script:fail = 1 } }

$spec = Get-CapWatchTaskSpec -RepoRoot 'C:\code\guards'

Check 'task name is the one already registered on the machine' ($spec.TaskName -eq 'ACC-ClaudeCapWatch')

# The regression Kyle reported: a console window popping up and vanishing every
# 60 seconds. The action runs in his interactive session on purpose (the balloon
# alert in claude-cap-watch.ps1 needs a desktop), so the window style is the
# only thing standing between him and a flash once a minute.
Check '-WindowStyle Hidden is present (no 60s console flash)' ($spec.Argument -match '-WindowStyle\s+Hidden')

Check 'runs the watcher script, quoted for spaces' ($spec.Argument -match '-File\s+"[^"]*claude-cap-watch\.ps1"')
Check 'no profile, bypassed execution policy' (($spec.Argument -match '-NoProfile') -and ($spec.Argument -match '-ExecutionPolicy\s+Bypass'))
Check 'script path points inside the given repo root' ($spec.ScriptPath -eq 'C:\code\guards\watcher\claude-cap-watch.ps1')

Check 'repeats every 60 seconds' ($spec.RepetitionInterval.TotalSeconds -eq 60)

# guards OI-025 bit twice on this: [TimeSpan]::MaxValue serialises to an
# ISO8601 duration ("P99999999DT23H59M59S") that Task Scheduler's XML rejects
# outright, so registration failed. Keep the duration long but bounded.
Check 'repetition duration is bounded, not TimeSpan::MaxValue' ($spec.RepetitionDuration -lt [TimeSpan]::MaxValue)
Check 'repetition duration is still effectively forever (>= 1 year)' ($spec.RepetitionDuration.TotalDays -ge 365)

exit $fail
