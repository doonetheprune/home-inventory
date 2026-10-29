#!/bin/sh
# Starts Larder as the unprivileged "node" user, after making sure that user
# owns the data folder. A fresh Docker volume, a bind mount made by root, or
# Home Assistant's add-on /data folder all start out belonging to root.
set -e
DATA="${LARDER_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  # Only when needed, so a big photo folder doesn't slow every start.
  if [ "$(stat -c %u "$DATA")" != "$(id -u node)" ]; then
    chown -R node:node "$DATA"
  fi
  # Busybox su replaces itself with the command (same process, same environment).
  # "--" stops su reading the command's own flags (like node's --disable-warning) as its options.
  exec su -s /bin/sh -c 'exec "$0" "$@"' node -- "$@"
fi
exec "$@"
