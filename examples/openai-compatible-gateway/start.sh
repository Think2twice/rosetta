#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data/chrome-profile /data/logs /data/generated-images /data/uploads/openai
rm -f /tmp/.X99-lock || true
rm -f /data/chrome-profile/SingletonLock \
      /data/chrome-profile/SingletonSocket \
      /data/chrome-profile/SingletonCookie || true

Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp > /data/logs/xvfb.log 2>&1 &
sleep 1
fluxbox > /data/logs/fluxbox.log 2>&1 &
sleep 1
pkill xmessage 2>/dev/null || true
x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -localhost -quiet > /data/logs/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 6080 localhost:5900 > /data/logs/novnc.log 2>&1 &

chromium \
  --display=:99 \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \
  --user-data-dir=/data/chrome-profile \
  --no-first-run \
  --no-default-browser-check \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --window-size=1440,1000 \
  https://chatgpt.com/ > /data/logs/chromium.log 2>&1 &

exec node /app/server.mjs
