# syntax=docker/dockerfile:1
# Biruni server. Stages:
#   test    — runs the full unit/integration suite (docker build --target test .)
#   runtime — the app (default)
# Override if Docker Hub rate-limits you: --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-slim
ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Corporate/sandbox proxies: pass --build-arg HTTPS_PROXY=… and --secret id=ca,src=<ca.pem>.
RUN --mount=type=secret,id=ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/ca npm ci --no-audit --no-fund

FROM deps AS test
COPY . .
ENV PROVIDER_MODE=mock OFFLINE_MODEL_CONFIG=off
RUN npx tsc --noEmit -p . && npm test

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8787 BIRUNI_DATA_DIR=/data BIRUNI_DB_PATH=/data/biruni.db
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY packages ./packages
COPY services ./services
COPY config ./config
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/lock/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings=ExperimentalWarning", "--import", "tsx", "apps/api/src/server.ts"]
