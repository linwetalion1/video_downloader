# Register Edge Extension Policy for local CRX (No Developer Mode needed)
$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$releaseDir = Join-Path $root "release"
$crxFile = Join-Path $releaseDir "video-downloader-explorer.crx"
$updateXml = Join-Path $releaseDir "update.xml"

# 1. Build extension package if needed
if (-not (Test-Path $crxFile)) {
    Write-Host "Building extension package..."
    Push-Location $root
    npm run package
    Pop-Location
}

# 2. Generate update.xml
$crxUri = "file:///" + ($crxFile -replace "\\", "/").Replace(" ", "%20")
$xmlContent = @"
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='dmbmefmahmopdpnkobgfoflcjdekbefc'>
    <updatecheck codebase='$crxUri' version='1.0.0' />
  </app>
</gupdate>
"@
[System.IO.File]::WriteAllText($updateXml, $xmlContent, [System.Text.Encoding]::UTF8)

# 3. Register in Edge policies (HKCU and HKLM)
$updateXmlUri = "file:///" + ($updateXml -replace "\\", "/").Replace(" ", "%20")

# HKCU
New-Item -Path "HKCU:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallSources" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallSources" -Name "1" -Value "file:///*"
New-Item -Path "HKCU:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallAllowlist" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallAllowlist" -Name "1" -Value "dmbmefmahmopdpnkobgfoflcjdekbefc"

# HKLM
New-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallSources" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallSources" -Name "1" -Value "file:///*"
New-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallAllowlist" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallAllowlist" -Name "1" -Value "dmbmefmahmopdpnkobgfoflcjdekbefc"
New-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist" -Name "1" -Value "dmbmefmahmopdpnkobgfoflcjdekbefc;$updateXmlUri"

Write-Host "Edge policies registered successfully!" -ForegroundColor Green
Write-Host "Extension ID: dmbmefmahmopdpnkobgfoflcjdekbefc"
Write-Host "Developer mode is no longer required."
