FROM node:22-bookworm-slim AS workspace

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

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

FROM workspace AS runtime-setup

CMD ["sh", "-c", "pnpm --filter @checkout-surge/db db:migrate && pnpm --filter @checkout-surge/db seed"]
