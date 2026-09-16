@echo off
REM Start the Classroom Book Recs server on Windows.
REM
REM 1. Edit the line below to point at where you cloned the repo.
REM 2. Run it once to start the server, OR add a shortcut to this file in the
REM    Startup folder (Win+R -> shell:startup) so it starts when you log in.
REM
REM The server listens on 0.0.0.0:8080 and prints the http://<LAN-IP>:8080
REM address that other devices on the network must use (localhost/0.0.0.0 will
REM not work for them).
REM
REM If other devices can't connect, allow inbound TCP 8080 once, from an
REM elevated (Run as administrator) Command Prompt:
REM   netsh advfirewall firewall add rule name="Classroom Book Recs 8080" dir=in action=allow protocol=TCP localport=8080
REM Then double-click deploy\lan-check.bat for a full report.
cd /d C:\path\to\Classroom-book-recs
node server.js
