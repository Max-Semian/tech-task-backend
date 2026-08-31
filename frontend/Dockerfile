FROM nginx:1.27-alpine

# Railway отдаёт порт в $PORT. Фильтр держит envsubst на одной переменной,
# иначе он съел бы и собственные $uri/$host из конфига nginx.
ENV PORT=8080
ENV NGINX_ENVSUBST_FILTER=PORT
# Адрес API. На Railway перекрывается публичным доменом сервиса api.
ENV API_BASE=http://localhost:3000

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker-config.sh /docker-entrypoint.d/40-api-base.sh
COPY . /usr/share/nginx/html/

RUN chmod +x /docker-entrypoint.d/40-api-base.sh

EXPOSE 8080
