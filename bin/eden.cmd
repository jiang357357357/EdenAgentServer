@echo off
setlocal EnableDelayedExpansion
set "EDEN_BIN=%~dp0"
if exist "%EDEN_BIN%..\tui\main.ts" (
  pushd "%EDEN_BIN%.."
  node --import tsx tui\main.ts %*
  set "EDEN_RESULT=!ERRORLEVEL!"
  popd
  exit /b !EDEN_RESULT!
)
if exist "%EDEN_BIN%..\node\node.exe" if exist "%EDEN_BIN%..\server\tui.mjs" (
  "%EDEN_BIN%..\node\node.exe" "%EDEN_BIN%..\server\tui.mjs" %*
  exit /b !ERRORLEVEL!
)
echo Eden TUI was not found in source or runtime. 1>&2
exit /b 1
