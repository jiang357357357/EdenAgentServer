$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ServerRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")
$VenvPython = Join-Path $ServerRoot.Path ".venv\Scripts\python.exe"
$Ok = $true

Write-Host "========================================================"
Write-Host "          MonAgent Server 环境检查工具 (Windows)"
Write-Host "========================================================"
Write-Host "Server 目录: $($ServerRoot.Path)"
Write-Host ""

if (Test-Path (Join-Path $ServerRoot.Path "pyproject.toml")) {
  Write-Host "✓ pyproject.toml 存在"
} else {
  Write-Host "✗ 未找到 pyproject.toml" -ForegroundColor Red
  $Ok = $false
}

if (Get-Command "uv" -ErrorAction SilentlyContinue) {
  Write-Host "✓ $(& uv --version)"
} else {
  Write-Host "✗ UV 未安装" -ForegroundColor Red
  $Ok = $false
}

if (Test-Path $VenvPython) {
  Write-Host "✓ Python: $(& $VenvPython --version)"
  try {
    & $VenvPython -c "import mon_agent_server, mon_agent_core, yaml, zmq; print('✓ dependencies ok')"
  } catch {
    Write-Host "✗ 关键依赖检查失败" -ForegroundColor Red
    $Ok = $false
  }
} else {
  Write-Host "✗ 虚拟环境不存在: $VenvPython" -ForegroundColor Red
  $Ok = $false
}

if ($Ok) {
  Write-Host "[ENV_STATUS:INSTALLED]"
  exit 0
}

Write-Host "[ENV_STATUS:NOT_INSTALLED]"
exit 1
