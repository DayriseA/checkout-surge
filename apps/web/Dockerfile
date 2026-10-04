ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS prune

WORKDIR /build

RUN npm install -g turbo@2.9.18

COPY . .

RUN turbo prune "web" --docker

FROM node:${NODE_VERSION} AS build

WORKDIR /build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY --from=prune /build/out/json/ ./

RUN --mount=type=cache,id=checkout-surge-pnpm-store,target=/pnpm/store \
  pnpm fetch --store-dir=/pnpm/store && \
  pnpm install --frozen-lockfile --offline --store-dir=/pnpm/store

COPY --from=prune /build/out/full/ ./
COPY tsconfig.base.json vitest.coverage.config.ts ./

RUN --mount=type=cache,id=checkout-surge-pnpm-store,target=/pnpm/store \
  pnpm --filter="web..." build

FROM node:${NODE_VERSION} AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0

COPY --from=build --chown=node:node /build/apps/web/.next/standalone/ ./
COPY --from=build --chown=node:node /build/apps/web/.next/static/ ./apps/web/.next/static/

USER node

CMD ["node", "apps/web/server.js"]
