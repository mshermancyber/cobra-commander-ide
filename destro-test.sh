#!/usr/bin/env bash
# Support-agent test harness.
#
#   ./destro-test.sh                     → mock smoke (no network/keys, ~5s): loop + tools + hooks
#   ./destro-test.sh real                → real diagnose-only session against this repo
#   ./destro-test.sh real <dir> "<ask>"  → real session against any project
#   ./destro-test.sh api                 → poke the live daemon through every layer
#
set -euo pipefail
WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$WORKDIR"
MODE="${1:-mock}"
SUPPORT_PORT="${DESTRO_PORT:-4102}"
API_PORT="${API_PORT:-4100}"

case "$MODE" in
  mock)
    echo "── support agent mock smoke (no network) ──"
    npx tsx src/destro/destro-cli.ts --target "$WORKDIR" --mock-llm
    ;;
  real)
    TARGET="${2:-$WORKDIR}"
    MSG="${3:-Diagnose the current state of this project. Read-only quick check: what is running, what looks wrong, one-paragraph verdict. Do not change anything.}"
    echo "── support agent REAL session (model key from .env) target=$TARGET ──"
    npx tsx src/destro/destro-cli.ts --target "$TARGET" --message "$MSG"
    ;;
  api)
    echo "── direct daemon :$SUPPORT_PORT ──"
    curl -s -m 5 "http://127.0.0.1:$SUPPORT_PORT/health"; echo
    curl -s -m 5 "http://127.0.0.1:$SUPPORT_PORT/sessions"; echo
    echo "── through api-server proxy :$API_PORT (401 = auth working, chain alive) ──"
    curl -s -m 5 -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:$API_PORT/api/v1/destro/health"
    ;;
  *)
    echo "usage: $0 [mock|real [dir] [\"ask\"]|api]"; exit 2 ;;
esac
