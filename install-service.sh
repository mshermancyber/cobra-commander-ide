#!/usr/bin/env bash
# Install Cobra Commander as a systemd service.
#
#   sudo ./install-service.sh [--user <account>]
#
# Resolves the install directory, the service account and the node location from
# the environment, so nothing about the host is baked into the repository.

set -euo pipefail

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="cobra-commander"
TEMPLATE="$WORKDIR/$SERVICE_NAME.service"
DEST="/etc/systemd/system/$SERVICE_NAME.service"

RUN_USER="${SUDO_USER:-$(id -un)}"
while [ $# -gt 0 ]; do
  case "$1" in
    --user) RUN_USER="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$EUID" -ne 0 ]; then
  echo "Run with sudo: sudo ./install-service.sh" >&2
  exit 1
fi

NODE_BIN="$(dirname "$(sudo -u "$RUN_USER" bash -lc 'command -v node' 2>/dev/null || command -v node)")"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN/node" ]; then
  echo "Could not find node on PATH for user $RUN_USER. Install Node 22+ first." >&2
  exit 1
fi

if [ ! -d "$WORKDIR/node_modules/tsx" ]; then
  echo "Dependencies missing. Run 'npm install' in $WORKDIR first." >&2
  exit 1
fi

if [ ! -f "$WORKDIR/.env" ]; then
  echo "No .env found in $WORKDIR. Copy .env.example to .env and set OPENAI_API_KEY first." >&2
  exit 1
fi

echo "Installing $SERVICE_NAME:"
echo "  user:    $RUN_USER"
echo "  workdir: $WORKDIR"
echo "  node:    $NODE_BIN"

sed -e "s#__USER__#$RUN_USER#g" \
    -e "s#__WORKDIR__#$WORKDIR#g" \
    -e "s#__NODE_BIN__#$NODE_BIN#g" \
    "$TEMPLATE" > "$DEST"

chmod 644 "$DEST"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

sleep 2
systemctl status "$SERVICE_NAME" --no-pager || true

API_PORT="$(grep -E '^API_PORT=' "$WORKDIR/.env" 2>/dev/null | cut -d= -f2)"
API_PORT="${API_PORT:-4100}"

cat <<EOM

Done. Service installed and running.
  API: http://127.0.0.1:$API_PORT (loopback, token-gated)

Commands:
  systemctl status $SERVICE_NAME
  systemctl restart $SERVICE_NAME
  journalctl -u $SERVICE_NAME -f

Smoke test: npx tsx src/smoke-test.ts
EOM
