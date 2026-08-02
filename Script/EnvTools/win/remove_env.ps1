$ErrorActionPreference = "Stop"
$ServerRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")

Write-Host "========================================================"
Write-Host "          MonAgent Server environment cleanup (Windows)"
Write-Host "========================================================"
Write-Host "Server directory: $($ServerRoot.Path)"
Write-Host ""

foreach ($Path in @(".venv", ".python-version")) {
  $FullPath = Join-Path $ServerRoot.Path $Path
  if (Test-Path $FullPath) {
    Remove-Item -Recurse -Force $FullPath
    Write-Host "[OK] Removed: $Path"
  } else {
    Write-Host "- Not found: $Path"
  }
}

Write-Host "[REMOVE_STATUS:SUCCESS]"
