ARG NODE_VERSION=22-bookworm-slim

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
COPY packages/fly-machines/package.json packages/fly-machines/package.json
COPY packages/logger/package.json packages/logger/package.json

RUN --mount=type=cache,id=checkout-surge-pnpm-store,target=/pnpm/store \
  pnpm fetch --store-dir=/pnpm/store

COPY . .

RUN --mount=type=cache,id=checkout-surge-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --offline --store-dir=/pnpm/store && \
  pnpm --filter="@checkout-surge/db..." build && \
  pnpm --filter="@checkout-surge/db" deploy --legacy --prod /deploy

FROM node:${NODE_VERSION} AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build --chown=node:node /deploy/ ./

USER node

CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/scripts/seed.js"]
