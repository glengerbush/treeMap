#!/usr/bin/env bash
# scripts/fetch-updates.sh — Daily background fetch of origin.
#
# Invoked by the systemd timer (treemap-fetch.timer). Just refreshes
# origin/main inside the active release so the in-app "Update available"
# badge reflects what's on origin without a live HTTP fetch from the
# browser. Exits 0 even if the network is down so the timer doesn't
# get stuck in failure backoff.

set -u
APP_DIR="${TREEMAP_APP_DIR:-${HOME}/treemap}"
CURRENT="${APP_DIR}/current"

if [[ ! -d "$CURRENT/.git" && ! -f "$CURRENT/.git" ]]; then
  echo "fetch-updates: no git repo at $CURRENT" >&2
  exit 0
fi

git -C "$CURRENT" fetch --quiet origin 2>&1 || {
  echo "fetch-updates: fetch failed (probably no network)" >&2
  exit 0
}

echo "fetch-updates: origin/main = $(git -C "$CURRENT" rev-parse --short=12 origin/main 2>/dev/null || echo unknown)"
exit 0
