#!/usr/bin/env bash
# DuckDNS auto-update for Classroom Book Recs.
# Keeps your DuckDNS hostname(s) pointed at your current public IP, so students
# can reach the site from school even when your home IP changes.
#
# SETUP (Linux / Raspberry Pi)
#   1. cp duckdns.conf.example duckdns.conf   (fill in your domain(s) + token)
#   2. Test once:        ./duckdns-update.sh
#   3. Run every 5 minutes so your IP stays current. Add this to your user's
#      crontab (crontab -e). Adjust the path to wherever you cloned the repo:
#
#        */5 * * * * /home/pi/Classroom-book-recs/deploy/duckdns-update.sh >>/home/pi/duckdns.log 2>&1
#
# TWO APPS, ONE PI: put both hostnames in duckdns.conf
# (DUCKDNS_DOMAINS=mybookrecs,myroomlibrary) and run this script from ONE repo
# only — one cron line updates both. See dual-host-pi.md.
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

# Comma-separated hostnames (DUCKDNS_DOMAINS="a,b"); the old single-name
# DUCKDNS_DOMAIN=... still works. Spaces are stripped so "a, b" is fine.
DOMAINS="$(echo "${DUCKDNS_DOMAINS:-$DUCKDNS_DOMAIN}" | tr -d '[:space:]')"

[ -z "$DOMAINS" ] && { echo "DUCKDNS_DOMAINS is empty in duckdns.conf"; exit 1; }
[ -z "$DUCKDNS_TOKEN" ] && { echo "DUCKDNS_TOKEN is empty in duckdns.conf"; exit 1; }

URL="https://www.duckdns.org/update?domains=$DOMAINS&token=$DUCKDNS_TOKEN&ip="
RESP=$(curl -s -k "$URL")

if [ "$RESP" = "OK" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') DuckDNS update OK ($DOMAINS)"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') DuckDNS update FAILED: $RESP"
fi
