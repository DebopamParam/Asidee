#!/bin/sh
# Runs on this machine; everything it does to the sandbox goes through the paddock CLI.
set -eu
paddock exec "$PADDOCK_SANDBOX" -- sh -c 'cat /proc/version; df -h / | tail -n 1'
echo "df's sizes are not this sandbox's disk limit; paddock verify $PADDOCK_SANDBOX shows the limit."
