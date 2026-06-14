FROM node:20-bookworm-slim AS base
WORKDIR /app

# Build deps for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --build-from-source=better-sqlite3

COPY server.js words.js game.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
