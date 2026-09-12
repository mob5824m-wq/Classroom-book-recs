@echo off
REM DuckDNS auto-update for Classroom Book Recs (Windows).
REM Keeps your DuckDNS hostname pointed at your current public IP.
REM
REM SETUP
REM   1. Edit the two lines below with your DuckDNS domain + token.
REM   2. Test once:   duckdns-update.bat
REM   3. Create a scheduled task to run it every 5 minutes:
REM        schtasks /create /sc minute /mo 5 /tn "DuckDNS Update" /tr "C:\Classroom-book-recs\deploy\duckdns-update.bat"

set DUCKDNS_DOMAIN=mybookrecs
set DUCKDNS_TOKEN=your-token-here

curl -k "https://www.duckdns.org/update?domains=%DUCKDNS_DOMAIN%&token=%DUCKDNS_TOKEN%&ip="
echo.
