@echo off
rem Started by the WinSW service. Loads %ProgramData%\OmniChat\config.env, then runs the server.
rem config.env keys that would change how the runtime, the shell or the loader behave are NOT exported
rem (see the "if /i" lines below; comparison is case-insensitive). Other keys are exported as before.
setlocal
cd /d "%~dp0"
set "OMNI_HOME=%ProgramData%\OmniChat"
set "DATA_DIR=%OMNI_HOME%\data"
set "WEB_DIR=%~dp0web"
set "NODE_ENV=production"
if exist "%OMNI_HOME%\config.env" (
  for /f "usebackq eol=# tokens=1* delims==" %%A in ("%OMNI_HOME%\config.env") do (
    set "OMNI_SKIP="
    if /i "%%A"=="NODE_OPTIONS" set "OMNI_SKIP=1"
    if /i "%%A"=="NODE_PATH" set "OMNI_SKIP=1"
    if /i "%%A"=="NODE_EXTRA_CA_CERTS" set "OMNI_SKIP=1"
    if /i "%%A"=="NODE_TLS_REJECT_UNAUTHORIZED" set "OMNI_SKIP=1"
    if /i "%%A"=="PATH" set "OMNI_SKIP=1"
    if /i "%%A"=="PATHEXT" set "OMNI_SKIP=1"
    if /i "%%A"=="COMSPEC" set "OMNI_SKIP=1"
    if /i "%%A"=="SYSTEMROOT" set "OMNI_SKIP=1"
    if /i "%%A"=="LD_PRELOAD" set "OMNI_SKIP=1"
    if /i "%%A"=="LD_LIBRARY_PATH" set "OMNI_SKIP=1"
    if /i "%%A"=="DYLD_INSERT_LIBRARIES" set "OMNI_SKIP=1"
    if /i "%%A"=="DYLD_LIBRARY_PATH" set "OMNI_SKIP=1"
    if defined OMNI_SKIP (
      echo config.env: ignoring "%%A", this key is not allowed 1>&2
    ) else (
      if not "%%B"=="" set "%%A=%%B"
    )
  )
)
rem Set after the config.env loop so config.env cannot override them.
rem OMNICHAT_SUPERVISED=1: WinSW restarts the service on any failure, so the server may exit 75 to apply an update.
set "OMNICHAT_INSTALL_TYPE=windows-service"
set "OMNICHAT_SUPERVISED=1"
"%~dp0runtime\node.exe" dist\boot.js
exit /b %ERRORLEVEL%
