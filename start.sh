#!/usr/bin/env bash
NODE_DIR=$(dirname "$(command -v node)")
export PATH="$NODE_DIR:$PATH"
exec npx tsx "$(dirname "$0")/start.ts" "$@"
