#!/usr/bin/env bash
# Double-click this file in Finder to start the server on macOS.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec ./start-linux.sh "$@"
