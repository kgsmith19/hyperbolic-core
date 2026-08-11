# netcheck — reset Wi-Fi adapter to apply 802.11ax mode.
#
# The Wi-Fi adapter's wireless mode property can be changed in the driver,
# but a profile-level disconnect/reconnect does not force the radio to
# renegotiate — it stays on the old mode. A full adapter cycle is required.
#
# This script disables and re-enables the Wi-Fi adapter, which causes the
# WLAN AutoConfig service to reconnect the SSID and renegotiate the link at
# the new 802.11ax mode.
#
# Requires administrator privileges.
#
#   powershell -ExecutionPolicy Bypass -File scripts\reset-wifi-adapter.ps1
#

$ErrorActionPreference = 'Stop'

# Check if running as admin
$isAdmin = ([Security.Principal.WindowsIdentity]::GetCurrent().Groups -contains [Security.Principal.SecurityIdentifier]"S-1-5-32-544")
if (-not $isAdmin) {
    Write-Error "This script requires administrator privileges. Please run as admin."
    exit 1
}

$adapterName = "Wi-Fi"

Write-Host "Reading current adapter state before reset..."
$adapterBefore = Get-NetAdapter -Name $adapterName -ErrorAction SilentlyContinue
if (-not $adapterBefore) {
    Write-Error "Wi-Fi adapter '$adapterName' not found"
    exit 1
}
Write-Host "  Status: $($adapterBefore.Status)"
Write-Host "  Link Speed: $($adapterBefore.LinkSpeed)"

# Read current wireless mode before reset
$wlanBefore = netsh wlan show interfaces
$wlanBeforeMode = $null
if ($wlanBefore -match "Radio type\s*:\s*(.+)") {
    $wlanBeforeMode = $matches[1].Trim()
}
Write-Host "  Wireless Mode (live): $($wlanBeforeMode ?? 'unknown')"

Write-Host "`nDisabling Wi-Fi adapter..."
Disable-NetAdapter -Name $adapterName -Confirm:$false
Start-Sleep -Seconds 2

Write-Host "Re-enabling Wi-Fi adapter..."
Enable-NetAdapter -Name $adapterName -Confirm:$false

Write-Host "Waiting for adapter to stabilize..."
Start-Sleep -Seconds 5

Write-Host "`nReading adapter state after reset..."
$adapterAfter = Get-NetAdapter -Name $adapterName -ErrorAction SilentlyContinue
if (-not $adapterAfter) {
    Write-Error "Wi-Fi adapter was not re-enabled; manual recovery may be needed"
    exit 1
}
Write-Host "  Status: $($adapterAfter.Status)"
Write-Host "  Link Speed: $($adapterAfter.LinkSpeed)"

# Read wireless mode after reset
$wlanAfter = netsh wlan show interfaces
$wlanAfterMode = $null
if ($wlanAfter -match "Radio type\s*:\s*(.+)") {
    $wlanAfterMode = $matches[1].Trim()
}
Write-Host "  Wireless Mode (live): $($wlanAfterMode ?? 'unknown')"

# Verify the wireless mode changed
if ($wlanBeforeMode -and $wlanAfterMode) {
    if ($wlanBeforeMode -eq $wlanAfterMode) {
        Write-Warning "Wireless mode did not change: $($wlanBeforeMode)"
        Write-Warning "The adapter may still be stuck. Try:"
        Write-Warning "  1. Manual Wi-Fi off/on in Windows Settings"
        Write-Warning "  2. Rebooting the computer"
        exit 1
    } else {
        Write-Host "`nSuccess! Wireless mode changed from $($wlanBeforeMode) to $($wlanAfterMode)"
    }
}

Write-Host "`nAdapter reset complete. You can now run:"
Write-Host "  python -m netcheck watch"
Write-Host "  python -m netcheck diagnose"
