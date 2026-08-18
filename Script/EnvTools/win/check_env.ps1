$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ServerRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")
$VenvPython = Join-Path $ServerRoot.Path ".venv\Scripts\python.exe"
$Ok = $true

Write-Host "========================================================"
Write-Host "          MonAgent Server environment checker (Windows)"
Write-Host "========================================================"
Write-Host "Server directory: $($ServerRoot.Path)"
Write-Host ""

if (Test-Path (Join-Path $ServerRoot.Path "pyproject.toml")) {
  Write-Host "[OK] pyproject.toml exists"
} else {
  Write-Host "[x] pyproject.toml not found" -ForegroundColor Red
  $Ok = $false
}

if (Get-Command "uv" -ErrorAction SilentlyContinue) {
  Write-Host "[OK] $(& uv --version)"
} else {
  Write-Host "[x] uv is not installed" -ForegroundColor Red
  $Ok = $false
}

if (Test-Path $VenvPython) {
  Write-Host "[OK] Python: $(& $VenvPython --version)"
  try {
    & $VenvPython -c "import mon_agent_server, yaml, zmq; from mon_agent_server.native_runtime import resolve_runtime_executable; print('[OK] dependencies available', resolve_runtime_executable())"
  } catch {
    Write-Host "[x] Critical dependency check failed" -ForegroundColor Red
    $Ok = $false
  }
} else {
  Write-Host "[x] Virtual environment not found: $VenvPython" -ForegroundColor Red
  $Ok = $false
}

if ($Ok) {
  Write-Host "[ENV_STATUS:INSTALLED]"
  exit 0
}

Write-Host "[ENV_STATUS:NOT_INSTALLED]"
exit 1
