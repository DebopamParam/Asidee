#!/bin/sh
set -eu
exec paddock exec "$PADDOCK_SANDBOX" -- sh -c '
  command -v npm >/dev/null || { echo "This sandbox has no npm. Use an image that has Node." >&2; exit 1; }
  npm install --global "@anthropic-ai/claude-code@$1" && claude --version
' install "${PADDOCK_FIELD_VERSION:-latest}"
