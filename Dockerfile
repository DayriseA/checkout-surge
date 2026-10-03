FROM node:22-bookworm-slim AS node-base

WORKDIR /workspace

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

FROM node-base AS workspace-install

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json tsconfig.base.json tsconfig.test.json ./
COPY biome.json ./
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
  pnpm install --frozen-lockfile --offline --store-dir=/pnpm/store

FROM workspace-install AS development-workspace

RUN pnpm build

FROM workspace-install AS runtime-tools-build

RUN --mount=type=cache,id=checkout-surge-pnpm-store,target=/pnpm/store \
  pnpm --filter="@checkout-surge/contracts" build && \
  pnpm --filter="@checkout-surge/contracts" deploy --legacy --prod /deploy

FROM node:22-bookworm-slim AS runtime-tools

WORKDIR /workspace

ENV NODE_ENV=production

COPY --from=runtime-tools-build --chown=node:node /deploy/ ./packages/contracts/
COPY --chown=node:node scripts/ ./scripts/

USER node

CMD ["node", "--version"]
