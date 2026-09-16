#!/usr/bin/env bash
# ============================================================
#  LAN reachability check for Classroom Book Recs (macOS/Linux/Pi)
#
#      ./deploy/lan-check.sh
#      ./deploy/lan-check.sh --port=9090
#      ./deploy/lan-check.sh --serve-test --port=8090
#
#  Reports why other devices can't open http://<this-machine-ip>:8080.
#  Read-only: it never changes your firewall - it prints the command to run.
# ============================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH - install Node.js from https://nodejs.org" >&2
  exit 1
fi
exec node "$HERE/lan-check.js" "$@"
