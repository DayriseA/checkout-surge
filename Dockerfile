FROM node:22-bookworm-slim AS node-base

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

FROM node-base AS runtime-setup

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY .env.example ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY scripts/env-utils.mjs scripts/run-with-env.mjs scripts/

RUN pnpm install --frozen-lockfile --filter @checkout-surge/db...

COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/contracts/src packages/contracts/src

RUN pnpm --filter @checkout-surge/contracts build

COPY packages/db/tsconfig.json packages/db/tsconfig.json
COPY packages/db/drizzle packages/db/drizzle
COPY packages/db/src packages/db/src

CMD ["sh", "-c", "pnpm --filter @checkout-surge/db db:migrate && pnpm --filter @checkout-surge/db seed"]

FROM node-base AS workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json tsconfig.base.json tsconfig.test.json ./
COPY biome.json vitest.unit.config.ts ./
COPY apps/api/package.json apps/api/package.json
COPY apps/load-orchestrator/package.json apps/load-orchestrator/package.json
COPY apps/mock-erp/package.json apps/mock-erp/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/logger/package.json packages/logger/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

FROM workspace AS api-runtime

ENV NODE_ENV=production
CMD ["node", "apps/api/dist/index.js"]

FROM workspace AS worker-runtime

ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/index.js"]

FROM workspace AS mock-erp-runtime

ENV NODE_ENV=production
CMD ["node", "apps/mock-erp/dist/index.js"]

FROM workspace AS web-runtime

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "web", "start"]

FROM grafana/k6:2.0.0 AS k6-binary

FROM workspace AS load-orchestrator-runtime

COPY --from=k6-binary /usr/bin/k6 /usr/local/bin/k6
ENV NODE_ENV=production
ENV K6_BINARY=/usr/local/bin/k6
CMD ["node", "apps/load-orchestrator/dist/index.js"]
