# Copy root frontend + Firebase config into Smart-Production-main (Netlify publish folder).
$root = $PSScriptRoot
$dest = Join-Path $root "Smart-Production-main"

$files = @(
  "script.js",
  "index.html",
  "style.css",
  "favicon.svg",
  "netlify.toml",
  "firebase.json",
  ".firebaserc"
)

foreach ($f in $files) {
  $src = Join-Path $root $f
  if (-not (Test-Path $src)) { continue }
  Copy-Item -Force $src (Join-Path $dest $f)
  Write-Host "Synced $f"
}

$fnSrc = Join-Path $root "functions"
$fnDest = Join-Path $dest "functions"
if (Test-Path $fnSrc) {
  if (-not (Test-Path $fnDest)) { New-Item -ItemType Directory -Path $fnDest | Out-Null }
  Copy-Item -Force (Join-Path $fnSrc "*") $fnDest
  Write-Host "Synced functions/"
}

Write-Host "Done. Online folder: $dest"
