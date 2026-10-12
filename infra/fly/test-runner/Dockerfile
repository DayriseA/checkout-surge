# Test runner image: Node + pnpm (as in the repository Dockerfile) plus a Docker engine, so the
# suite runs unchanged against docker-compose.test.yml. Everything stateful lives on /data.
FROM node:22-bookworm

RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
    > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

ENV npm_config_store_dir=/data/pnpm-store

# Start Docker, then stay up for at most MAX_RUNTIME_SECONDS: when sleep exits, the Machine stops.
CMD ["sh", "-c", "dockerd --data-root /data/docker >/var/log/dockerd.log 2>&1 & exec sleep \"${MAX_RUNTIME_SECONDS:-7200}\""]
