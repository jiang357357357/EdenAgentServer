param(
  [switch]$NoWait
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ServerRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")
$AgentRoot = Resolve-Path -LiteralPath (Join-Path $ServerRoot.Path "..")

Write-Host ""
Write-Host "========================================================"
Write-Host "          MonAgent Server environment installer (Windows)"
Write-Host "========================================================"
Write-Host "Agent root: $($AgentRoot.Path)"
Write-Host "Server directory: $($ServerRoot.Path)"
Write-Host "Virtual environment: $($ServerRoot.Path)\.venv"
Write-Host ""

Push-Location $ServerRoot.Path
try {
  if (-not (Test-Path "pyproject.toml")) {
    Write-Host "[x] pyproject.toml not found" -ForegroundColor Red
    Write-Host "[INSTALL_STATUS:FAILED]"
    exit 1
  }

  Write-Host "[1/4] Checking the uv package manager..."
  if (-not (Get-Command "uv" -ErrorAction SilentlyContinue)) {
    Write-Host "[x] uv is not installed; installing it automatically..." -ForegroundColor Yellow
    python -m pip install uv
  }
  if (-not (Get-Command "uv" -ErrorAction SilentlyContinue)) {
    Write-Host "[x] uv installation failed" -ForegroundColor Red
    Write-Host "[INSTALL_STATUS:FAILED]"
    exit 1
  }
  Write-Host "[OK] uv is ready: $(& uv --version)"
  Write-Host ""

  Write-Host "[2/4] Installing and pinning Python 3.12.6..."
  & uv python install 3.12.6
  & uv python pin 3.12.6
  Write-Host "[OK] Python version pinned to 3.12.6"
  Write-Host ""

  Write-Host "[3/4] Syncing dependencies and creating the virtual environment..."
  & uv sync
  Write-Host "[OK] Dependency synchronization completed"
  Write-Host ""

  Write-Host "[4/4] Verifying the installation..."
  $VenvPython = Join-Path $ServerRoot.Path ".venv\Scripts\python.exe"
  if (-not (Test-Path $VenvPython)) {
    Write-Host "[x] Virtual environment Python not found: $VenvPython" -ForegroundColor Red
    Write-Host "[INSTALL_STATUS:FAILED]"
    exit 1
  }
  Write-Host "[OK] Python: $(& $VenvPython --version)"
  & $VenvPython -c "import mon_agent_server, mon_agent_core, yaml, zmq; print('[OK] dependencies available')"
  Write-Host ""
  Write-Host "[OK] MonAgent Server environment installation completed"
  Write-Host "[INSTALL_STATUS:SUCCESS]"
} finally {
  Pop-Location
}

if (-not $NoWait) {
  Read-Host "Press Enter to exit"
}
