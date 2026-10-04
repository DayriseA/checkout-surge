ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS prune

WORKDIR /build

RUN npm install -g turbo@2.9.18

COPY . .

RUN turbo prune "@checkout-surge/db" --docker

FROM node:${NODE_VERSION} AS build

WORKDIR /build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY --from=prune /build/out/json/ ./

RUN --mount=type=cache,id=checkout-surge-pnpm-store,target=/pnpm/store \
  pnpm fetch --store-dir=/pnpm/store && \
  pnpm install --frozen-lockfile --offline --store-dir=/pnpm/store

COPY --from=prune /build/out/full/ ./
COPY tsconfig.base.json ./

RUN --mount=type=cache,id=checkout-surge-pnpm-store,target=/pnpm/store \
  pnpm --filter="@checkout-surge/db..." build && \
  pnpm --filter="@checkout-surge/db" deploy --legacy --prod /deploy

FROM node:${NODE_VERSION} AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build --chown=node:node /deploy/ ./

USER node

CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/scripts/seed.js"]
