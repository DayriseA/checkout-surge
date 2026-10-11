// Shared remote-store topology; proof evidence capture is a separate, opt-in layer.
export function configureProofTopology(config, environment) {
  if (!environment.apps.stores) return config;
  const role = config.metadata?.role;
  if (role === "stores") {
    config.guest = { cpu_kind: "performance", cpus: 2, memory_mb: 4096 };
    config.containers = config.containers.filter((c) => ["postgres", "redis"].includes(c.name));
    // Both environments use the same immutable dependencies.
    config.containers.find((c) => c.name === "postgres").image =
      "registry-1.docker.io/library/postgres@sha256:aa90e97ee862e558111d34cfb8b2c4bec768c2b039fb791341686928560263b3";
    config.containers.find((c) => c.name === "redis").image =
      "registry-1.docker.io/library/redis@sha256:ca0acbb137c1dc3339c8b147a58fd6f42775d4599327b50e7b116c23de501af2";
    config.containers[0].cmd[2] = config.containers[0].cmd[2].replace(
      "listen_addresses=127.0.0.1",
      "listen_addresses='*'",
    );
    config.containers[1].cmd[2] = config.containers[1].cmd[2].replace(
      "--bind 127.0.0.1",
      "--bind 0.0.0.0 ::",
    );
  } else if (role === "core") {
    delete config.volumes;
    delete config.mounts;
    config.containers = config.containers.filter((c) => !["postgres", "redis"].includes(c.name));
    for (const container of config.containers) {
      container.depends_on = container.depends_on?.filter(
        (d) => !["postgres", "redis"].includes(d.name),
      );
    }
    const setup = config.containers.find((c) => c.name === "setup");
    setup.secrets.push({ env_var: "REDIS_URL" });
    setup.files = [
      { guest_path: "/app/wait-for-stores.mjs", local_path: "infra/fly/wait-for-stores.mjs" },
    ];
    setup.cmd = [
      "sh",
      "-c",
      "node /app/wait-for-stores.mjs && node dist/scripts/migrate.js && node dist/scripts/seed.js",
    ];
    const control = config.containers.find((c) => c.name === "api");
    const buyer = structuredClone(control);
    control.env.HOST = "127.0.0.1";
    control.env.API_ROLE = "control";
    control.env.API_BUYER_BASE_URLS = [4001, 4002, 4003]
      .map((port) => `http://127.0.0.1:${port}`)
      .join(",");
    control.env.RUNNER_CPUS = "16";
    control.env.RUNNER_MEMORY_MB = "32768";
    control.env.EXPECTED_FLY_ORGANIZATION = environment.organization;
    control.env.CORE_IDLE_STOP_URL = `${environment.publicOrigin}/__gate/idle-stop`;
    control.secrets.push({ env_var: "GATE_LIFECYCLE_TOKEN" });
    control.cmd = [
      "sh",
      "-c",
      'export API_BASE_URL="http://[$FLY_PRIVATE_IP]:4004"; exec node dist/index.js',
    ];
    for (const port of [4001, 4002, 4003]) {
      const copy = structuredClone(buyer);
      copy.name = `buyer-${port - 4000}`;
      copy.env = {
        HOST: "127.0.0.1",
        PORT: String(port),
        API_ROLE: "buyer",
        WORKER_BASE_URL: "http://127.0.0.1:4300",
        API_CONTROL_BASE_URL: "http://127.0.0.1:4000",
        API_LISTEN_BACKLOG: "8192",
        API_POSTGRES_POOL_MAX: "10",
        API_TRUSTED_PROXY_CIDRS: "127.0.0.0/8,::1/128",
        WEB_ORIGIN: environment.publicOrigin,
      };
      copy.secrets = copy.secrets.filter(
        (s) => !["RUNNER_FLY_API_TOKEN", "CORE_FLY_API_TOKEN"].includes(s.env_var),
      );
      copy.healthchecks[0].exec.command[2] = copy.healthchecks[0].exec.command[2].replace(
        ":4000/",
        `:${port}/`,
      );
      config.containers.push(copy);
      control.depends_on.push({ name: copy.name, condition: "healthy" });
    }
    config.containers.find((c) => c.name === "web").env.API_BASE_URL = "http://127.0.0.1:4004";
    const caddy = config.containers.find((c) => c.name === "caddy");
    caddy.image =
      "registry-1.docker.io/library/caddy@sha256:173b26306d711395accaeba8b67afcaad2a085ccb1e6bf26010bfe8c095a5229";
    caddy.files[0].local_path = "infra/caddy/Caddyfile.proof";
    // The proof's k6 ingress now crosses this process as well as the buyer API.
    caddy.cmd = [
      "sh",
      "-c",
      "set -e; ulimit -Hn 1048576; ulimit -Sn 1048576; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile",
    ];
  } else if (role === "runner") {
    config.guest = { cpu_kind: "performance", cpus: 16, memory_mb: 32768 };
    if (environment.name !== "proof" || environment.proofEvidenceCapture !== true) return config;
    config.env.PROOF_K6_CAPTURE_DIR = "/var/lib/checkout-surge/load-orchestrator/proof-capture";
    config.files = [
      ...(config.files ?? []),
      {
        guest_path: "/app/proof-observer.mjs",
        local_path: "infra/fly/runner/proof-observer.mjs",
      },
    ];
    // init.exec replaces image ENTRYPOINT/CMD; retain the kernel setup and UID drop explicitly.
    config.init = {
      exec: [
        "/usr/local/bin/fly-entrypoint.sh",
        "sh",
        "-c",
        [
          "set -eu",
          "ready_dir=$(mktemp -d /tmp/proof-observer.XXXXXX)",
          'ready="$ready_dir/ready.json"',
          'node /app/proof-observer.mjs "$ready" & observer=$!',
          "trap 'kill -TERM \"$observer\" 2>/dev/null || true' EXIT",
          "trap 'exit 1' INT TERM",
          'timeout 10 sh -c \'alive() { kill -0 "$1" && grep -Eq "^State:[[:space:]]+[RSD][[:space:]]" "/proc/$1/status"; }; while [ ! -s "$1" ]; do alive "$2" || exit 1; sleep 0.1; done; alive "$2"\' sh "$ready" "$observer"',
          'kill -0 "$observer"',
          'grep -Eq "^State:[[:space:]]+[RSD][[:space:]]" "/proc/$observer/status"',
          "exec node dist/index.js",
        ].join("; "),
      ],
    };
  } else if (role === "gate" || role === "guard") {
    config.env.RUNNER_FLY_APP = environment.apps.runner;
    config.env.STORES_FLY_APP = environment.apps.stores;
    config.env.EXPECTED_FLY_ORGANIZATION = environment.organization;
    // Single-container gate/guard Machines receive the gate app's staged secrets normally.
  }
  return config;
}
