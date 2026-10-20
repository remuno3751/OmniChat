@echo off
rem OmniChat account administration on this PC (Windows service install). Installed next to run-service.cmd.
rem Runs dist\admin-cli.js with the same %ProgramData%\OmniChat\config.env that the "OmniChat" service uses.
rem   omnichat-admin.cmd create [username] [--role admin or user]
rem   omnichat-admin.cmd list
rem   omnichat-admin.cmd set-password [username]
rem   omnichat-admin.cmd role [username] admin or user
rem   omnichat-admin.cmd disable [username]   and   omnichat-admin.cmd enable [username]
rem The password is asked on the console, or taken from OMNICHAT_ADMIN_PASSWORD. Never put it on the command line.
rem Must run from an Administrator prompt: the data folder is readable by SYSTEM and Administrators only.
rem NOT TESTED on Windows yet (written without a Windows test machine).
setlocal
cd /d "%~dp0"
set "OMNI_HOME=%ProgramData%\OmniChat"
set "DATA_DIR=%OMNI_HOME%\data"
set "WEB_DIR=%~dp0web"
set "NODE_ENV=production"

net session >nul 2>&1
if errorlevel 1 (
  echo omnichat-admin: run this from an Administrator prompt. 1>&2
  exit /b 1
)
if not exist "%~dp0runtime\node.exe" (
  echo omnichat-admin: runtime\node.exe not found. Reinstall OmniChat. 1>&2
  exit /b 1
)

rem config.env keys that would change how the runtime, the shell or the loader behave are NOT set
rem (same deny list as run-service.cmd). Other keys are set as they are.
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

"%~dp0runtime\node.exe" dist\admin-cli.js %*
exit /b %ERRORLEVEL%
