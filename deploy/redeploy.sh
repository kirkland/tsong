#!/usr/bin/env bash
# Redeploy tsong to the production VPS: pull latest, reinstall deps, rebuild the client,
# then restart the service. The build runs against the *running* server (no downtime);
# only the final restart is disruptive, so by default we hold it until there's a break
# between matches — no live rally gets cut off. A graceful restart snapshots the current
# match and the next process resumes it, and clients auto-reconnect, so even a mid-match
# restart is a brief freeze rather than a lost game.
#
# Usage:
#   ./deploy/redeploy.sh            # wait for a gap between matches before restarting
#   ./deploy/redeploy.sh --force    # restart immediately (TSONG_FORCE=1 also works)
#
# Override the target host with TSONG_HOST=root@1.2.3.4 ./deploy/redeploy.sh
set -euo pipefail

HOST="${TSONG_HOST:-root@159.223.137.196}"
FORCE="${TSONG_FORCE:-}"
[ "${1:-}" = "--force" ] && FORCE=1

ssh "$HOST" 'bash -s' -- "${FORCE:-}" <<'REMOTE'
  set -e
  FORCE="${1:-}"
  cd /opt/tsong
  sudo -u tsong git pull
  sudo -u tsong npm ci
  sudo -u tsong npm run build          # build first — this doesn't touch the live server

  # PORT the server listens on locally (from the systemd env file; default 3000).
  PORT="$(sed -n 's/^PORT=//p' /etc/tsong.env)"
  PORT="${PORT:-3000}"

  if [ -z "$FORCE" ]; then
    echo "waiting for a break between matches before restarting (up to ~2 min)…"
    for _ in $(seq 1 60); do
      if ! curl -fsS "http://localhost:${PORT}/api/status" 2>/dev/null | grep -q '"playing":true'; then
        break
      fi
      sleep 2
    done
  fi

  systemctl restart tsong
  sleep 2
  systemctl status tsong --no-pager | head -5
REMOTE
