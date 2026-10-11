FROM grafana/k6:2.0.0 AS k6
FROM node:22-bookworm-slim AS build
WORKDIR /lab
ENV PNPM_HOME=/pnpm
ENV PATH="/pnpm:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm exec turbo run build --filter=api --filter=worker --filter=mock-erp --concurrency=1

FROM node:22-bookworm-slim
WORKDIR /lab
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 procps ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6
COPY --from=build /lab /lab
ENV NODE_ENV=production
ENV FEASIBILITY_LAB=true
CMD ["node", "scripts/feasibility/core.mjs"]
