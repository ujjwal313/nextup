# Builds the store-ready zip with only the files the extension ships.
# store-assets/ (promo images for the dashboards) stays out of the package.
$manifest = Get-Content manifest.json | ConvertFrom-Json
$zip = "dist/nextup-v$($manifest.version).zip"

New-Item -ItemType Directory -Force dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip }

Compress-Archive -Path manifest.json, popup.html, popup.js, popup.css, assets, _locales -DestinationPath $zip
Write-Host "Packed $zip ($([math]::Round((Get-Item $zip).Length / 1KB)) KB)"
