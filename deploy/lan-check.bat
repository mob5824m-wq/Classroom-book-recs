@echo off
REM ============================================================
REM  LAN reachability check for Classroom Book Recs (Windows)
REM  Double-click this file, or run it from a terminal:
REM      deploy\lan-check.bat
REM      deploy\lan-check.bat --port=9090
REM      deploy\lan-check.bat --serve-test --port=8090
REM
REM  It answers "why can't other devices open http://192.168.x.x:8080 ?"
REM  Nothing here changes your data or your firewall - it only reports
REM  (the netsh command it prints has to be run by you, in admin).
REM ============================================================
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install it from https://nodejs.org
  echo then run this file again.
  pause
  exit /b 1
)
node "%~dp0lan-check.js" %*
echo.
pause
