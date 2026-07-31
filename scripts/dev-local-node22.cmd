@echo off
setlocal

set "ROOT=%~dp0.."
set "NODE22=%ROOT%\.tools\node-v22.12.0-win-x64"

if not exist "%NODE22%\node.exe" (
  echo Portable Node 22 was not found at "%NODE22%".
  echo Download https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-x64.zip and extract it into .tools first.
  exit /b 1
)

set "PATH=%NODE22%;%PATH%"
if "%~1"=="tunnel" (
  call npm.cmd exec -- shopify app dev
) else (
  call npm.cmd exec -- shopify app dev --use-localhost --install-mkcert
)
