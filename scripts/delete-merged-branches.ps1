<#
.SYNOPSIS
  Delete remote branches whose work is already in main.

.DESCRIPTION
  Every branch listed below is provably in main -- either an ancestor of it, or
  squash-merged via a pull request confirmed merged. Deleting them loses
  nothing: the commits stay reachable from each PR's record and from main.

  Verifies each branch still exists before trying, and re-checks against the
  remote afterwards, so a partial run is safe to repeat.

.EXAMPLE
  pwsh scripts/delete-merged-branches.ps1 -WhatIf   # show what would go
  pwsh scripts/delete-merged-branches.ps1           # do it
#>
[CmdletBinding(SupportsShouldProcess)]
param([string]$Remote = 'origin')

$ErrorActionPreference = 'Stop'

$Stale = @(
    'claude/phase-2-packet-loss'
    'claude/phase-3-mtu'
    'claude/phase-4-tcp'
    'claude/phase-5-dual-stack'
    'claude/phase-6-dns'
    'claude/phase-7-routing'
    'claude/phase-8-tls'
    'claude/phase-9-buffer'
    'claude/phase-10-synthesis'
    'claude/phase-12-fix-application'
    'claude/phase-13-verification-testing'
    'claude/phase-14-regression-monitoring'
    'claude/phase-15-wifi-diagnostics'
    'claude/loop-goal-4umvxd'
    'claude/spec-driven-dev-continue-41309l'
    'claude/lean-network-troubleshooting-ydt29q'
    'claude/network-checker-phase-24-polish-bb91r4'
    'claude/network-checker-phase-29-restore-hypotheses'
    'claude/network-checker-phase-30-remaining-issues'
    'claude/readme-quickstart'
    'claude/fix-application-real-writes'
    'claude/fix-engine-measured-likelihoods'
    'claude/e2e-fault-injection-mtu-tls'
    'claude/network-checker-diagnosis-41789b'
    'tmp-probe-delete'
)

Write-Host "Fetching $Remote ..." -ForegroundColor Cyan
git fetch --prune $Remote | Out-Null

$live = (git ls-remote --heads $Remote) |
        ForEach-Object { ($_ -split "`t")[1] -replace '^refs/heads/', '' }

$present = $Stale | Where-Object { $live -contains $_ }
$already = $Stale | Where-Object { $live -notcontains $_ }

if ($already) {
    Write-Host "Already gone ($($already.Count)):" -ForegroundColor DarkGray
    $already | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}

if (-not $present) {
    Write-Host "Nothing to delete." -ForegroundColor Green
    exit 0
}

Write-Host "`nDeleting $($present.Count) merged branch(es) from $Remote :" -ForegroundColor Yellow
$present | ForEach-Object { Write-Host "  $_" }

if ($PSCmdlet.ShouldProcess($Remote, "delete $($present.Count) branches")) {
    # One push: a single round trip, and git reports per-ref success itself.
    git push $Remote --delete @present

    git fetch --prune $Remote | Out-Null
    $stillThere = (git ls-remote --heads $Remote) |
                  ForEach-Object { ($_ -split "`t")[1] -replace '^refs/heads/', '' } |
                  Where-Object { $present -contains $_ }

    if ($stillThere) {
        Write-Host "`nStill present after the push:" -ForegroundColor Red
        $stillThere | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        exit 1
    }
    Write-Host "`nDone. Remaining branches:" -ForegroundColor Green
    git branch -r
}
