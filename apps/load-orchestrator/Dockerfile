ARG NODE_VERSION=22-bookworm-slim

FROM grafana/k6:2.0.0 AS k6-binary

FROM node:${NODE_VERSION} AS build

WORKDIR /build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/load-orchestrator/package.json apps/load-orchestrator/package.json
COPY apps/mock-erp/package.json apps/mock-erp/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/logger/package.json packages/logger/package.json

RUN --mount=type=cache,id=checkout-surge-pnpm-store,target=/pnpm/store \
  pnpm fetch --store-dir=/pnpm/store

COPY . .

RUN --mount=type=cache,id=checkout-surge-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --offline --store-dir=/pnpm/store && \
  pnpm --filter="load-orchestrator..." build && \
  pnpm --filter="load-orchestrator" deploy --legacy --prod /deploy

FROM node:${NODE_VERSION} AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV K6_BINARY=/usr/local/bin/k6

COPY --from=k6-binary /usr/bin/k6 /usr/local/bin/k6
COPY --from=build --chown=node:node /deploy/ ./

RUN install -d -o node -g node /var/lib/checkout-surge/load-orchestrator

USER node

CMD ["node", "dist/index.js"]

# Fly.io runner variant: a root entrypoint applies kernel limits, then drops to `node`.
FROM runtime AS runtime-fly

USER root

COPY --chmod=0755 infra/fly/runner/load-orchestrator-entrypoint.sh /usr/local/bin/fly-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/fly-entrypoint.sh"]
CMD ["node", "dist/index.js"]
