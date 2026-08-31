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

# По умолчанию API + фоновые воркеры (выдача/recovery).
# Поставщики supplier-a/b переопределяют CMD в docker-compose.
CMD ["node", "src/index.js"]
