#!/usr/bin/env bash
# Install Self-Host Starter as a systemd service so it starts at boot and
# restarts if it crashes.
#
#   sudo tools/install-service.sh /media/you/MYSTICK [username]
#
# The optional username is the account the server runs as. It defaults to the
# user who invoked sudo, which is almost always what you want: the service then
# has exactly the access that user has to the USB stick, and no more.

set -euo pipefail

SERVICE_NAME=selfhost
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script needs root to write ${UNIT_FILE}. Re-run with sudo." >&2
  exit 1
fi

USB_DIR="${1:-}"
if [[ -z "$USB_DIR" ]]; then
  echo "Usage: sudo $0 /path/to/usb/stick [username]" >&2
  exit 1
fi

USB_DIR="$(cd "$USB_DIR" && pwd -P)"
if [[ ! -f "$USB_DIR/server/server.js" ]]; then
  echo "No server/server.js under $USB_DIR — is that the right folder?" >&2
  exit 1
fi

RUN_USER="${2:-${SUDO_USER:-root}}"
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  echo "User '$RUN_USER' does not exist." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
[[ -x "$USB_DIR/runtime/bin/node" ]] && NODE_BIN="$USB_DIR/runtime/bin/node"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js was not found on this machine. Install it first." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Node.js 18 or newer is required. Found $("$NODE_BIN" --version)." >&2
  exit 1
fi

echo "  Installing ${SERVICE_NAME}.service"
echo "    site   : $USB_DIR"
echo "    user   : $RUN_USER"
echo "    node   : $NODE_BIN"

cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Self-Host Starter website server
Documentation=file://$USB_DIR/README-FIRST.txt
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$USB_DIR
ExecStart=$NODE_BIN $USB_DIR/server/server.js
Restart=always
RestartSec=5
# Do not give up after repeated restarts: a USB stick that briefly drops out
# should recover on its own, not leave the site down until someone notices.
StartLimitIntervalSec=0
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

# The service only ever needs to read the stick and write its own data folder.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
ReadWritePaths=$USB_DIR/data $USB_DIR/site

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
sleep 2

echo
systemctl --no-pager --lines=15 status "$SERVICE_NAME" || true
cat <<MSG

  Installed.

    sudo systemctl status $SERVICE_NAME     is it running?
    sudo systemctl restart $SERVICE_NAME    restart after changing settings
    sudo journalctl -u $SERVICE_NAME -f     live logs
    sudo systemctl disable --now $SERVICE_NAME   stop and remove from boot

  If this was the first run, the generated admin password is in:
    $USB_DIR/data/FIRST-RUN-PASSWORD.txt

MSG
