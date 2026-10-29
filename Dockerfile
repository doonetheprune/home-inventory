# Larder: one image for Docker, Compose and the Home Assistant add-on.
# Multi-arch friendly: no native modules (SQLite comes with Node).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-alpine
ENV NODE_ENV=production \
    LARDER_PORT=8080 \
    LARDER_DATA_DIR=/data \
    LARDER_WEB_DIR=/app/dist/web
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Starts as root only long enough to give the data folder to the node user.
COPY docker/entrypoint.sh /usr/local/bin/larder-entrypoint
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
ENTRYPOINT ["larder-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/main.js"]
