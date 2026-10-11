#!/usr/bin/env bash
# Fail if the working tree carries a live credential or a specific host address.
#
# This repository is meant to be portable: addresses, ports, paths and
# credentials are configuration, never source. Run it before a release:
#
#   ./scripts/check-no-secrets.sh
#
# Files that legitimately contain address *ranges* — SSRF guards, air-gap
# network policy, this script — are listed in ALLOW_RANGES.

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

EXCLUDES=(
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
  --exclude-dir=archive --exclude='package-lock.json' --exclude='*.lock'
  --exclude='LICENSE' --exclude='check-no-secrets.sh'
)

# Files allowed to contain private/reserved address ranges.
ALLOW_RANGES='src/core/url-validator.ts|src/deploy/airgap.ts|src/core/security-scanner.ts|src/providers/openai-compatible.ts|src/remote/auth.ts|src/remote/server.ts|src/destro/ops-tools.ts'

fail=0

report() {
  local label="$1" hits="$2"
  if [ -n "$hits" ]; then
    echo "FAIL: $label"
    echo "$hits" | sed 's/^/      /'
    echo
    fail=1
  else
    echo "ok:   $label"
  fi
}

# 1. Live API keys. Placeholders in docs are short or contain "your".
hits=$(grep -rIEn 'sk-[A-Za-z0-9_-]{20,}' "${EXCLUDES[@]}" . 2>/dev/null \
  | grep -viE 'your-key|your-openai|your-anthropic|example|placeholder|xxx' || true)
report "no live API key literals" "$hits"

# 2. Specific private host addresses (ranges in guard files are allowed).
hits=$(grep -rIEn '\b(10|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.[0-9]{1,3}\.[0-9]{1,3}\b' "${EXCLUDES[@]}" . 2>/dev/null \
  | grep -vE "^\./($ALLOW_RANGES):" \
  | grep -vE '\.0\.0/|/8|/12|/16|0\.0\.0\.0' || true)
report "no private host addresses" "$hits"

# 3. Overlay-network (CGNAT) peer addresses.
hits=$(grep -rIEn '\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b' "${EXCLUDES[@]}" . 2>/dev/null \
  | grep -vE "^\./($ALLOW_RANGES):" || true)
report "no overlay peer addresses" "$hits"

# 4. Credential assignments with a real-looking value, outside docs/examples.
hits=$(grep -rIEn '(PASSWORD|SECRET|_API_KEY|PASSWD)=[^ \t"'"'"']{8,}' \
  --include='*.ts' --include='*.sh' --include='*.json' --include='*.service' \
  --include='*.yml' --include='*.yaml' "${EXCLUDES[@]}" . 2>/dev/null \
  | grep -viE 'your-|example|placeholder|changeme|<|\$\{|process\.env|scrypt\$' || true)
report "no credential assignments" "$hits"

# 5. Absolute paths from a specific machine's layout.
hits=$(grep -rIEn '/home/[a-z_][a-z0-9_-]*/|/Users/[a-z_][a-z0-9_-]*/' \
  "${EXCLUDES[@]}" . 2>/dev/null \
  | grep -viE 'homedir|\$HOME|~/|<user>|/home/<|example' || true)
report "no machine-specific home paths" "$hits"

# 6. A committed .env.
if [ -f .env ]; then
  echo "FAIL: .env exists in the tree — it must never be committed"
  fail=1
else
  echo "ok:   no .env in the tree"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "Leak check FAILED."
  exit 1
fi
echo "Leak check passed."
