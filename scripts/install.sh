#!/usr/bin/env bash
# Install the autoresearch plugin into OpenCode 2's global plugins directory.
#
# Writes a one-line entrypoint that re-exports this checkout's src/index.ts,
# so `git pull` updates the plugin in place. Skills and the /autoresearch
# command are registered by the plugin itself — nothing else is copied.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
PLUGIN_DIR="$CONFIG_DIR/plugins"
ENTRY="$PLUGIN_DIR/autoresearch.ts"

if ! command -v opencode >/dev/null 2>&1; then
  echo "warning: opencode not found on PATH" >&2
else
  version="$(opencode --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [[ -n "$version" && "${version%%.*}" -lt 2 ]]; then
    echo "error: OpenCode $version found; this plugin requires OpenCode 2 (run: opencode upgrade)" >&2
    exit 1
  fi
fi

mkdir -p "$PLUGIN_DIR"
printf 'export { default } from "%s/src/index.ts"\n' "$REPO_ROOT" > "$ENTRY"

echo "Installed: $ENTRY"
echo "  -> $REPO_ROOT/src/index.ts"
echo
echo "Restart OpenCode (opencode service restart, if you use the background service),"
echo "then run: /autoresearch <goal>"
