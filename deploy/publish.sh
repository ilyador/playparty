#!/bin/sh
set -eu
if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Run with sudo to validate and restart the existing Caddy container.' >&2
  exit 1
fi
ufw allow 7882/udp comment 'Playparty video and audio'
ufw allow 7881/tcp comment 'Playparty call TCP fallback'
docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker restart caddy
printf '%s\n' 'Caddy restarted. Open the public URL configured for your deployment.'
