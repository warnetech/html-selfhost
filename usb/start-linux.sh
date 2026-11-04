#!/usr/bin/env sh
# Self-Host Starter launcher for Linux and other Unix systems.
#
#   ./start-linux.sh              start with the saved settings
#   ./start-linux.sh --port 8000  override the port for this run
#   ./start-linux.sh --check      validate the configuration and exit

set -eu

# Work from the directory this script lives in, so the stick can be mounted
# anywhere without the paths breaking.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$SCRIPT_DIR"

printf '\n  Self-Host Starter\n  -----------------------------------------------\n\n'

if [ -x "$SCRIPT_DIR/runtime/bin/node" ]; then
  NODE_BIN="$SCRIPT_DIR/runtime/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN=node
else
  cat <<'MSG'
  Node.js was not found on this machine.

  Debian / Ubuntu / Raspberry Pi OS:
      sudo apt update && sudo apt install -y nodejs

  Fedora:
      sudo dnf install -y nodejs

  Or download it from https://nodejs.org/ and put a portable copy in
  this folder as runtime/bin/node.

MSG
  exit 1
fi

NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  printf '  Node.js 18 or newer is required. Found: %s\n\n' "$("$NODE_BIN" --version)"
  exit 1
fi

printf '  Starting the web server. Press Ctrl+C to stop.\n\n'
exec "$NODE_BIN" server/server.js "$@"
