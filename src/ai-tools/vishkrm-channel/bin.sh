#!/bin/bash
# vishkrm-channel launcher — runs the TS via tsx from this package's node_modules
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/vishkrm-channel.ts" "$@"
