#!/usr/bin/env bash
# Remove the autoresearch plugin entrypoint from OpenCode 2's global plugins directory.
# Project files (.auto/) are never touched.
set -euo pipefail

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
ENTRY="$CONFIG_DIR/plugins/autoresearch.ts"

if [[ -f "$ENTRY" ]]; then
  rm "$ENTRY"
  echo "Removed: $ENTRY"
else
  echo "Nothing to remove ($ENTRY not found)"
fi
