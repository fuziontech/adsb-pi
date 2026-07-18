#!/bin/bash
# Launch chromium fullscreen on the radar once the server is up.
set -u

URL="${RADAR_URL:-http://localhost:8080/?kiosk=1}"
BASE="${URL%%\?*}"

for _ in $(seq 1 90); do
  if curl -sf -o /dev/null "${BASE}api/aircraft"; then
    break
  fi
  sleep 2
done

exec chromium \
  --kiosk "$URL" \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  --check-for-update-interval=31536000 \
  --hide-crash-restore-bubble
