#!/bin/sh
set -eu
exec asd exec "$ASIDEE_SANDBOX" -- sh -c '
  command -v npm >/dev/null || { echo "This sandbox has no npm. Use an image that has Node." >&2; exit 1; }
  npm install --global "@anthropic-ai/claude-code@$1" && claude --version
' install "${ASIDEE_FIELD_VERSION:-latest}"
