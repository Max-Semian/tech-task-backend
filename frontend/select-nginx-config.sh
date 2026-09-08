#!/bin/sh
# Выбор конфига nginx: если задан API_PROXY_UPSTREAM — проксируем API через nginx
# (один-origin, SSE с proxy_buffering off); иначе nginx раздаёт только статику,
# а браузер ходит в API напрямую по API_BASE (как на Railway).
set -e
mkdir -p /etc/nginx/templates
if [ -n "$API_PROXY_UPSTREAM" ]; then
  cp /etc/nginx/conf-src/proxy.conf.template /etc/nginx/templates/default.conf.template
  echo "nginx: API proxy enabled -> $API_PROXY_UPSTREAM"
else
  cp /etc/nginx/conf-src/static.conf.template /etc/nginx/templates/default.conf.template
  echo "nginx: static mode"
fi
