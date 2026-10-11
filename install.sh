#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# Cobra Commander — Installer
# Usage: sudo ./install.sh
# ──────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="${SUDO_USER:-$(whoami)}"
SERVICE_USER_HOME="$(eval echo "~${SERVICE_USER}")"

banner() {
  echo -e "${CYAN}${BOLD}"
  echo '  ╔═══════════════════════════════════════════════════════════╗'
  echo '  ║           COBRA COMMANDER  INSTALLER                     ║'
  echo '  ║         Multi-Model IDE — Any model, your rules          ║'
  echo '  ╚═══════════════════════════════════════════════════════════╝'
  echo -e "${NC}\n"
}

# ── Prerequisites ────────────────────────────────────────
check_prerequisites() {
  echo -e "${BOLD}[1/5]${NC} Checking prerequisites..."
  local errors=0

  # Must be run with sudo (or as root)
  if [ "$EUID" -ne 0 ]; then
    echo -e "  ${RED}✗${NC} Must run with sudo: ${BOLD}sudo ./install.sh${NC}"
    exit 1
  fi

  # Node.js >= 22
  local node_bin=""
  for candidate in \
    "${SERVICE_USER_HOME}/.local/node-v22.11.0-linux-x64/bin/node" \
    "$(which node 2>/dev/null || true)" \
    "/usr/local/bin/node" \
    "${SERVICE_USER_HOME}/.nvm/versions/node/v22*/bin/node"; do
    if [ -x "$candidate" ] 2>/dev/null; then
      local ver
      ver="$("$candidate" -v 2>/dev/null | sed 's/v//' | cut -d. -f1)"
      if [ "$ver" -ge 22 ] 2>/dev/null; then
        node_bin="$candidate"
        break
      fi
    fi
  done

  if [ -n "$node_bin" ]; then
    echo -e "  ${GREEN}✓${NC} Node.js $($node_bin -v) at ${node_bin}"
  else
    echo -e "  ${RED}✗${NC} Node.js 22+ not found"
    echo -e "    ${DIM}Install: https://nodejs.org or use nvm/fnm${NC}"
    errors=$((errors + 1))
  fi

  # Git
  if command -v git &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Git $(git --version | awk '{print $3}')"
  else
    echo -e "  ${RED}✗${NC} Git not found"
    errors=$((errors + 1))
  fi

  # Tailscale (optional but recommended)
  if command -v tailscale &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Tailscale detected $(tailscale version 2>/dev/null | head -1) ${DIM}(optional bind mode)${NC}"
  else
    echo -e "  ${YELLOW}⚠${NC} Tailscale not found (remote access won't work)"
  fi

  if [ "$errors" -gt 0 ]; then
    echo -e "\n  ${RED}${errors} prerequisite(s) missing.${NC}"
    exit 1
  fi

  NODE_BIN="$node_bin"
  NPX_BIN="$(dirname "$node_bin")/npx"
}

# ── Install dependencies ─────────────────────────────────
install_deps() {
  echo -e "\n${BOLD}[2/5]${NC} Installing dependencies..."

  cd "$SCRIPT_DIR"
  sudo -u "$SERVICE_USER" "$NPX_BIN" --yes true 2>/dev/null || true
  sudo -u "$SERVICE_USER" "$(dirname "$NODE_BIN")/npm" install --omit=optional 2>&1 | tail -3
  echo -e "  ${GREEN}✓${NC} Dependencies installed"
}

# ── Build check ──────────────────────────────────────────
build_check() {
  echo -e "\n${BOLD}[3/5]${NC} Type checking..."

  cd "$SCRIPT_DIR"
  if sudo -u "$SERVICE_USER" "$NPX_BIN" tsc --noEmit 2>&1 | tail -3; then
    echo -e "  ${GREEN}✓${NC} TypeScript compiles cleanly"
  else
    echo -e "  ${YELLOW}⚠${NC} TypeScript errors (may still run)"
  fi
}

# ── Create systemd service ───────────────────────────────
install_service() {
  echo -e "\n${BOLD}[4/5]${NC} Installing systemd service..."

  local service_file="/etc/systemd/system/cobra-commander.service"

  cat > "$service_file" << SERVICE
[Unit]
Description=Cobra Commander — Multi-Model IDE
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${NPX_BIN} tsx src/daemon.ts
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-${SCRIPT_DIR}/.env
StandardOutput=journal
StandardError=journal
KillMode=mixed
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
SERVICE

  systemctl daemon-reload
  systemctl enable cobra-commander
  systemctl restart cobra-commander

  sleep 2
  if systemctl is-active cobra-commander &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Service installed and running"
  else
    echo -e "  ${YELLOW}⚠${NC} Service installed but not running — check: journalctl -u cobra-commander"
  fi
}

# ── Smoke test ───────────────────────────────────────────
smoke_test() {
  echo -e "\n${BOLD}[5/5]${NC} Smoke test..."

  sleep 2
  cd "$SCRIPT_DIR"
  if sudo -u "$SERVICE_USER" "$NPX_BIN" tsx src/smoke-test.ts 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} All checks passed"
  else
    echo -e "  ${YELLOW}⚠${NC} Smoke test failed (daemon may still be starting)"
    echo -e "    ${DIM}Retry: npx tsx src/smoke-test.ts${NC}"
  fi
}

# ── Main ─────────────────────────────────────────────────
main() {
  banner

  echo -e "${BOLD}Install from:${NC} ${SCRIPT_DIR}"
  echo -e "${BOLD}Service user:${NC} ${SERVICE_USER}"
  echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

  check_prerequisites
  install_deps
  build_check
  install_service
  smoke_test

  # ── Done ───────────────────────────────────────────────
  local api_port
  api_port="$(grep -E '^API_PORT=' "${SCRIPT_DIR}/.env" 2>/dev/null | cut -d= -f2)"
  api_port="${api_port:-4100}"

  echo -e "\n${CYAN}${BOLD}┌───────────────────────────────────────────────────────────┐${NC}"
  echo -e "${CYAN}${BOLD}│${NC}  ${GREEN}${BOLD}Cobra Commander installed and running.${NC}               ${CYAN}${BOLD}│${NC}"
  echo -e "${CYAN}${BOLD}│${NC}                                                           ${CYAN}${BOLD}│${NC}"
  echo -e "${CYAN}${BOLD}│${NC}  ${BOLD}API:${NC}     http://127.0.0.1:${api_port} (token-gated)            ${CYAN}${BOLD}│${NC}"
  echo -e "${CYAN}${BOLD}│${NC}  ${DIM}Web UI:${NC}  set REMOTE_ENABLED=true in .env             ${CYAN}${BOLD}│${NC}"
  echo -e "${CYAN}${BOLD}│${NC}                                                           ${CYAN}${BOLD}│${NC}"
  echo -e "${CYAN}${BOLD}│${NC}  ${DIM}Status:${NC}  systemctl status cobra-commander              ${CYAN}${BOLD}│${NC}"
  echo -e "${CYAN}${BOLD}│${NC}  ${DIM}Logs:${NC}    journalctl -u cobra-commander -f              ${CYAN}${BOLD}│${NC}"
  echo -e "${CYAN}${BOLD}│${NC}  ${DIM}Test:${NC}    npx tsx src/smoke-test.ts                     ${CYAN}${BOLD}│${NC}"
  echo -e "${CYAN}${BOLD}└───────────────────────────────────────────────────────────┘${NC}\n"
}

main "$@"
