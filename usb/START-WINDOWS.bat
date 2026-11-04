@echo off
setlocal enabledelayedexpansion
title Self-Host Starter

rem Run from the folder this script lives in, whatever drive letter the USB
rem stick was assigned this time.
cd /d "%~dp0"

echo.
echo   Self-Host Starter
echo   -----------------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js was not found on this computer.
  echo.
  echo   Install the LTS build from https://nodejs.org/ and run this again.
  echo   A portable copy can also be placed in this folder as:
  echo       runtime\node.exe
  echo.
  if exist "runtime\node.exe" (
    echo   Using the bundled runtime instead.
    set "NODE_BIN=runtime\node.exe"
  ) else (
    pause
    exit /b 1
  )
) else (
  set "NODE_BIN=node"
)

rem Refuse to start on a Node too old for the APIs the server uses.
for /f "tokens=1 delims=." %%v in ('"%NODE_BIN%" -p "process.versions.node"') do set NODE_MAJOR=%%v
if !NODE_MAJOR! LSS 18 (
  echo   Node.js 18 or newer is required. This machine has:
  "%NODE_BIN%" --version
  echo.
  pause
  exit /b 1
)

echo   Starting the web server. Leave this window open.
echo   Press Ctrl+C to stop.
echo.

"%NODE_BIN%" server\server.js %*

echo.
echo   The server stopped.
pause
