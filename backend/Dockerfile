FROM node:20-alpine

WORKDIR /app

# зависимости отдельным слоем (кэшируется при пересборке)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# приложение
COPY src ./src
COPY schema.sql ./
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000

# Один образ на обе роли. docker-compose переопределяет command напрямую,
# а Railway роль выбирает переменной ROLE: там на сервис можно задать env,
# но не отдельную стартовую команду.
CMD ["sh", "-c", "if [ \"$ROLE\" = supplier ]; then exec node src/suppliers/server.js; else exec node src/index.js; fi"]
