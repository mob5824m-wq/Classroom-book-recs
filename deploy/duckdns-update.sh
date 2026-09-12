#!/usr/bin/env bash
# DuckDNS auto-update for Classroom Book Recs.
# Keeps your DuckDNS hostname pointed at your current public IP, so students
# can reach the site from school even when your home IP changes.
#
# SETUP (Linux / Raspberry Pi)
#   1. cp duckdns.conf.example duckdns.conf   (fill in your domain + token)
#   2. Test once:        ./duckdns-update.sh
#   3. Run every 5 minutes so your IP stays current. Add this to your user's
#      crontab (crontab -e). Adjust the path to wherever you cloned the repo:
#
#        */5 * * * * /home/pi/Classroom-book-recs/deploy/duckdns-update.sh >>/home/pi/duckdns.log 2>&1
#
# (Some routers can update DuckDNS directly in their DDNS settings — if yours
#  can, you don't need this script at all.)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/duckdns.conf"

if [ ! -f "$CONF" ]; then
  echo "No $CONF found. Copy duckdns.conf.example -> duckdns.conf and add your token."
  exit 1
fi
# shellcheck disable=SC1090
source "$CONF"

[ -z "$DUCKDNS_DOMAIN" ] && { echo "DUCKDNS_DOMAIN is empty in duckdns.conf"; exit 1; }
[ -z "$DUCKDNS_TOKEN" ] && { echo "DUCKDNS_TOKEN is empty in duckdns.conf"; exit 1; }

URL="https://www.duckdns.org/update?domains=$DUCKDNS_DOMAIN&token=$DUCKDNS_TOKEN&ip="
RESP=$(curl -s -k "$URL")

if [ "$RESP" = "OK" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') DuckDNS update OK ($DUCKDNS_DOMAIN.duckdns.org)"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') DuckDNS update FAILED: $RESP"
fi
