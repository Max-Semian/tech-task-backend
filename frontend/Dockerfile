FROM nginx:1.27-alpine

# Railway отдаёт порт в $PORT. Фильтр держит envsubst на нужных переменных,
# иначе он съел бы и собственные $uri/$host из конфига nginx.
ENV PORT=8080
ENV NGINX_ENVSUBST_FILTER="PORT|API_PROXY_UPSTREAM"
ENV API_PROXY_UPSTREAM=
# Адрес API. На Railway перекрывается публичным доменом сервиса api.
ENV API_BASE=http://localhost:3000

COPY nginx-static.conf.template /etc/nginx/conf-src/static.conf.template
COPY nginx-proxy.conf.template /etc/nginx/conf-src/proxy.conf.template
COPY select-nginx-config.sh /docker-entrypoint.d/15-select-config.sh
COPY docker-config.sh /docker-entrypoint.d/40-api-base.sh
COPY . /usr/share/nginx/html/

RUN chmod +x /docker-entrypoint.d/15-select-config.sh /docker-entrypoint.d/40-api-base.sh

EXPOSE 8080
