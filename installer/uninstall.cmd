@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
if not exist "%~dp0node\node.exe" (
  echo Missing portable Node. Extract the complete Windows zip again.
  pause
  exit /b 1
)
"%~dp0node\node.exe" "%~dp0installer\install.mjs" --uninstall
set "result=%errorlevel%"
if not "%result%"=="0" echo Uninstall needs attention. Topic data is retained. See the reason above. Exit code: %result%
pause
exit /b %result%
