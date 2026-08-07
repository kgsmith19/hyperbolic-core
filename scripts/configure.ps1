# netcheck — local credential setup.
#
# Prompts for the optional credentials and writes them to .env (gitignored).
# Nothing typed here is echoed to the screen, kept in shell history, or passed
# as a command-line argument, so it never lands in a process listing either.
#
#   powershell -ExecutionPolicy Bypass -File scripts\configure.ps1
#
# Every value is optional. Skip any of them and the matching feature reports
# `unavailable` rather than failing — netcheck runs fully without all of it.
#
# The Supabase value must be the SERVICE ROLE key, not the publishable one:
# every table has RLS enabled with no policies, so anon deliberately cannot
# write. Find it at:
#   https://supabase.com/dashboard/project/<project-ref>/settings/api

$ErrorActionPreference = 'Stop'

$repo    = Split-Path $PSScriptRoot -Parent
$envPath = Join-Path $repo '.env'

# ---------------------------------------------------------------- helpers ---

function Read-Secret {
    param([string]$Label, [string]$Current)

    if ($Current) { $hint = '  [already set - Enter keeps it]' }
    else          { $hint = '  [Enter to skip]' }

    $secure = Read-Host -Prompt "$Label$hint" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try   { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }

    if ([string]::IsNullOrWhiteSpace($value)) { return $Current }
    return $value
}

function Read-Plain {
    param([string]$Label, [string]$Current)
    $answer = Read-Host -Prompt "$Label  [$Current]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Current }
    return $answer
}

# Load any existing .env so re-running this is safe and non-destructive.
$vals = @{}
if (Test-Path $envPath) {
    foreach ($line in Get-Content $envPath) {
        $t = $line.Trim()
        if ($t -and -not $t.StartsWith('#') -and $t.Contains('=')) {
            $i = $t.IndexOf('=')
            $vals[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
        }
    }
    Write-Host "Found an existing .env - blank answers keep current values.`n"
}

function Cur([string]$k) { if ($vals.ContainsKey($k)) { return $vals[$k] } else { return '' } }

# ----------------------------------------------------------------- prompt ---

Write-Host '--- Supabase mirror (optional; SQLite is always the source of truth) ---'
$vals['SUPABASE_URL'] = Read-Plain  'SUPABASE_URL (https://<project-ref>.supabase.co)' (Cur 'SUPABASE_URL')
$vals['SUPABASE_KEY'] = Read-Secret 'SUPABASE_KEY (service role, hidden)' (Cur 'SUPABASE_KEY')

Write-Host "`n--- Cable modem: DOCSIS SNR, power, uncorrectable codewords ---"
Write-Host '    (192.168.100.1 answered 401 here, so it only needs credentials)'
$vals['MODEM_HOST'] = Read-Plain  'MODEM_HOST' (& { $c = Cur 'MODEM_HOST'; if ($c) { $c } else { '192.168.100.1' } })
$vals['MODEM_USER'] = Read-Plain  'MODEM_USER' (Cur 'MODEM_USER')
$vals['MODEM_PASS'] = Read-Secret 'MODEM_PASS (hidden)' (Cur 'MODEM_PASS')

Write-Host "`n--- Router: uptime, clients, and whether AiProtection/DPI is on ---"
$vals['ROUTER_HOST'] = Read-Plain  'ROUTER_HOST' (& { $c = Cur 'ROUTER_HOST'; if ($c) { $c } else { '192.168.50.1' } })
$vals['ROUTER_USER'] = Read-Plain  'ROUTER_USER' (Cur 'ROUTER_USER')
$vals['ROUTER_PASS'] = Read-Secret 'ROUTER_PASS (hidden)' (Cur 'ROUTER_PASS')

# ------------------------------------------------------------------ write ---

$out = @('# netcheck credentials. Gitignored. Written by scripts/configure.ps1.',
         '# Re-run that script to change anything; do not edit by hand if you can',
         '# avoid it, so the file permissions below stay correct.',
         '')
foreach ($k in 'SUPABASE_URL','SUPABASE_KEY','MODEM_HOST','MODEM_USER','MODEM_PASS',
                'ROUTER_HOST','ROUTER_USER','ROUTER_PASS') {
    $out += "$k=$(Cur $k)"
}
Set-Content -Path $envPath -Value $out -Encoding utf8

# A service-role key bypasses RLS entirely, so this file is worth locking down
# rather than leaving on the default inherited ACL under C:\code.
try {
    icacls $envPath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
    Write-Host "`nWrote $envPath (permissions restricted to $env:USERNAME)"
} catch {
    Write-Host "`nWrote $envPath"
    Write-Warning "Could not restrict permissions: $($_.Exception.Message)"
}

# ----------------------------------------------------------------- verify ---

Write-Host "`nVerifying (no secret is printed):"
Push-Location $repo
try {
    if ((Cur 'SUPABASE_KEY')) {
        python -m netcheck sync
    } else {
        Write-Host '  SUPABASE_KEY not set - skipping sync check.'
    }
    if ((Cur 'MODEM_USER') -or (Cur 'ROUTER_USER')) {
        python -c @"
from netcheck.__main__ import load_env
from netcheck import environ
load_env()
for name in ('modem', 'router'):
    r = getattr(environ, name)()
    print(f'  {name}: {r[\"state\"]}' + (f' - {r.get(\"reason\",\"\")}' if r['state'] != 'ok' else ''))
"@
    }
} finally { Pop-Location }

Write-Host "`nDone. Next: python -m netcheck watch"
