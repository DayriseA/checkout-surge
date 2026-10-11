import { pathToFileURL } from "node:url";

export async function waitForStores(
  probe,
  {
    timeoutMs = 120_000,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      await probe();
      return;
    } catch {
      if (now() >= deadline)
        throw new Error("Proof stores did not become ready before setup deadline.");
      await sleep(1000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: postgres } = await import("postgres");
  const { default: Redis } = await import("ioredis");
  await waitForStores(async () => {
    // Each attempt has bounded client operations; no migration runs until both authenticate.
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Fly setup script is not a Turbo task.
    const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Fly setup script is not a Turbo task.
    const redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 2000,
      commandTimeout: 2000,
      retryStrategy: () => null,
    });
    let timer;
    try {
      await Promise.race([
        (async () => {
          await sql`select 1`;
          await redis.ping();
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Store probe timed out.")), 4000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      redis.disconnect();
      await sql.end({ timeout: 1 });
    }
  });
}
