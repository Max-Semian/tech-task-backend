#!/bin/sh
# Витрина статическая, но адрес API известен только на старте контейнера.
# Записываем его в config.js — он подключается раньше app.js.
set -e
printf 'window.API_BASE = "%s";\n' "$API_BASE" > /usr/share/nginx/html/config.js
echo "api-base: $API_BASE"
