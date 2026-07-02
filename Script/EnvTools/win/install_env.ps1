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
Write-Host "          MonAgent Server 环境安装工具 (Windows)"
Write-Host "========================================================"
Write-Host "Agent 根目录: $($AgentRoot.Path)"
Write-Host "Server 目录: $($ServerRoot.Path)"
Write-Host "虚拟环境: $($ServerRoot.Path)\.venv"
Write-Host ""

Push-Location $ServerRoot.Path
try {
  if (-not (Test-Path "pyproject.toml")) {
    Write-Host "✗ 未找到 pyproject.toml" -ForegroundColor Red
    Write-Host "[INSTALL_STATUS:FAILED]"
    exit 1
  }

  Write-Host "[1/4] 检查 UV 包管理器..."
  if (-not (Get-Command "uv" -ErrorAction SilentlyContinue)) {
    Write-Host "✗ UV 未安装，正在自动安装..." -ForegroundColor Yellow
    python -m pip install uv
  }
  if (-not (Get-Command "uv" -ErrorAction SilentlyContinue)) {
    Write-Host "✗ UV 安装失败" -ForegroundColor Red
    Write-Host "[INSTALL_STATUS:FAILED]"
    exit 1
  }
  Write-Host "✓ UV 已就绪: $(& uv --version)"
  Write-Host ""

  Write-Host "[2/4] 安装并固定 Python 3.12.6..."
  & uv python install 3.12.6
  & uv python pin 3.12.6
  Write-Host "✓ Python 版本已固定为 3.12.6"
  Write-Host ""

  Write-Host "[3/4] 同步依赖并创建虚拟环境..."
  & uv sync
  Write-Host "✓ 依赖同步完成"
  Write-Host ""

  Write-Host "[4/4] 验证安装..."
  $VenvPython = Join-Path $ServerRoot.Path ".venv\Scripts\python.exe"
  if (-not (Test-Path $VenvPython)) {
    Write-Host "✗ 虚拟环境 Python 不存在: $VenvPython" -ForegroundColor Red
    Write-Host "[INSTALL_STATUS:FAILED]"
    exit 1
  }
  Write-Host "✓ Python: $(& $VenvPython --version)"
  & $VenvPython -c "import mon_agent_server, mon_agent_core, yaml, zmq; print('✓ dependencies ok')"
  Write-Host ""
  Write-Host "✓ MonAgent Server 环境安装完成"
  Write-Host "[INSTALL_STATUS:SUCCESS]"
} finally {
  Pop-Location
}

if (-not $NoWait) {
  Read-Host "按回车键退出"
}
