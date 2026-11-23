#!/bin/sh
set -eu

media_root="${MEDIA_ROOT:-/app/.data/media}"
mkdir -p "$media_root"
chown node:node "$media_root"

# Run the application unprivileged; tini remains PID 1 for signal forwarding.
exec /sbin/tini -- su-exec node "$@"
