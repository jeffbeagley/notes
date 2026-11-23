#!/bin/sh
set -eu

media_root="${MEDIA_ROOT:-/app/.data/media}"
mkdir -p "$media_root"

if [ "$(id -u)" -eq 0 ]; then
  chown node:node "$media_root"
  exec /sbin/tini -- su-exec node "$@"
fi

# Kubernetes already supplies the non-root identity and volume group.
exec /sbin/tini -- "$@"
