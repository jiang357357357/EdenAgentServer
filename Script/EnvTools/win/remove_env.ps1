$ErrorActionPreference = "Stop"
$ServerRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")

Write-Host "========================================================"
Write-Host "          MonAgent Server 环境清理工具 (Windows)"
Write-Host "========================================================"
Write-Host "Server 目录: $($ServerRoot.Path)"
Write-Host ""

foreach ($Path in @(".venv", ".python-version")) {
  $FullPath = Join-Path $ServerRoot.Path $Path
  if (Test-Path $FullPath) {
    Remove-Item -Recurse -Force $FullPath
    Write-Host "✓ 已删除: $Path"
  } else {
    Write-Host "- 不存在: $Path"
  }
}

Write-Host "[REMOVE_STATUS:SUCCESS]"
