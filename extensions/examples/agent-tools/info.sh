#!/bin/sh
# Runs on this machine; everything it does to the sandbox goes through the asd CLI.
set -eu
asd exec "$ASIDEE_SANDBOX" -- sh -c 'cat /proc/version; df -h / | tail -n 1'
echo "df's sizes are not this sandbox's disk limit; asd verify $ASIDEE_SANDBOX shows the limit."
