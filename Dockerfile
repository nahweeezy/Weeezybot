FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# Keep the live config + database on a mounted volume so they survive redeploys.
ENV CONFIG_PATH=/data/config.json \
    DATABASE_PATH=/data/weeezybot.db
VOLUME /data

# Give the bot time to flush pending XP / rank-ups on shutdown.
STOPSIGNAL SIGTERM
CMD ["node", "src/index.js"]
