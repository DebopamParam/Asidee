#!/bin/sh
# Runs on this machine; everything it does to the sandbox goes through the paddock CLI.
set -eu
exec paddock exec "$PADDOCK_SANDBOX" -- sh -c 'cat /proc/version; df -h / | tail -n 1'
