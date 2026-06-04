#!/usr/bin/env bash
# Redeploy tsong to the production VPS: pull latest, reinstall deps, rebuild the
# client, and restart the service. nginx and the TLS cert are untouched — they
# only need attention if the domain or proxy config changes.
#
# Usage:  ./deploy/redeploy.sh
set -euo pipefail

HOST="${TSONG_HOST:-root@159.223.137.196}"

ssh "$HOST" '
  set -e
  cd /opt/tsong
  sudo -u tsong git pull
  sudo -u tsong npm ci
  sudo -u tsong npm run build
  systemctl restart tsong
  sleep 2
  systemctl status tsong --no-pager | head -5
'
