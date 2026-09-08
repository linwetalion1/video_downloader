# Unregister Edge Extension Policy
$ErrorActionPreference = "SilentlyContinue"

Remove-ItemProperty -Path "HKCU:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallSources" -Name "1"
Remove-ItemProperty -Path "HKCU:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallAllowlist" -Name "1"

Remove-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallSources" -Name "1"
Remove-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallAllowlist" -Name "1"
Remove-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist" -Name "1"

Write-Host "Edge policies removed." -ForegroundColor Yellow
