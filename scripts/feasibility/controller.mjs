import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  deleteGeneratedRunDurable,
  purgeResetRunDurable,
} from "../../packages/db/dist/demo-run-maintenance.js";
import { runDatabaseMigrations } from "../../packages/db/dist/migrations.js";
import { readCgroupSample } from "./cgroup.mjs";
import {
  authorize,
  configuration,
  contracts,
  db,
  fastify,
  isMain,
  logger,
  sleep,
} from "./common.mjs";
import { withRunFence } from "./postgres.mjs";

export const modes = ["demo", "no-redis", "no-queue"];
const productId = "11111111-1111-4111-8111-111111111111";
const presetId = "44444444-4444-4444-8444-444444444443";

export async function setupDatabase(config) {
  const name = new URL(config.databaseUrl).pathname.slice(1);
  if (!["checkout_surge_proof", "checkout_surge_test"].includes(name))
    throw new Error("Only an isolated proof/test database is allowed.");
  await runDatabaseMigrations({ databaseUrl: config.databaseUrl });
  const connection = db.createDatabaseConnection(config.databaseUrl, { max: 1 });
  try {
    await connection.sql.unsafe(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  } finally {
    await connection.close();
  }
}

export async function createRun(sql, mode, snapshot) {
  if (!modes.includes(mode)) throw new Error("Unknown experimental mode.");
  snapshot = contracts.acceptedRunConfigSnapshotSchema.parse(snapshot);
  const runId = randomUUID();
  const saleOfferId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`insert into products(id,sku,slug,name) values(${productId},'PROOF','proof','Proof product') on conflict do nothing`;
    await tx`insert into demo_presets(id,slug,visibility,display,traffic_config,inventory_config,erp_config,backpressure_config)
      values(${presetId},'proof-experimental','admin',${JSON.stringify({ name: "Feasibility", description: "Throwaway experiment", sortOrder: 0, outcomeFocus: [] })}::jsonb,
        ${JSON.stringify(snapshot.trafficConfig)}::jsonb,${JSON.stringify(snapshot.inventoryConfig)}::jsonb,${JSON.stringify(snapshot.erpConfig)}::jsonb,${JSON.stringify(snapshot.backpressureConfig)}::jsonb) on conflict do nothing`;
    await tx`insert into sale_offers(id,product_id,name,allocated_stock,sale_starts_at,sale_ends_at)
      values(${saleOfferId},${productId},'Proof run',${snapshot.inventoryConfig.startingStock},now()-interval '1 minute',now()+interval '1 hour')`;
    await tx`insert into demo_runs(id,preset_id,preset_name,operator_mode,status,config_snapshot,correlation_id,sale_offer_id,started_at)
      values(${runId},${presetId},'Feasibility','admin','active',${JSON.stringify(snapshot)}::jsonb,${randomUUID()},${saleOfferId},now())`;
    await tx`insert into demo_run_sale_contexts(run_id,sale_offer_id) values(${runId},${saleOfferId})`;
    await tx`insert into proof_runs(run_id,mode) values(${runId},${mode})`;
    if (mode === "no-redis")
      await tx`insert into proof_inventory(run_id,sale_offer_id,allocated,remaining)
      values(${runId},${saleOfferId},${snapshot.inventoryConfig.startingStock},${snapshot.inventoryConfig.startingStock})`;
  });
  return { runId, saleOfferId, mode, generation: 1, snapshot };
}

export async function snapshotRun(sql, run) {
  const [business] = await sql`
    select count(*)::int as orders,
      count(*) filter(where o.status='queued')::int as queued,
      count(*) filter(where o.status='processing')::int as processing,
      count(*) filter(where o.status='confirmed')::int as confirmed,
      count(*) filter(where o.status='failed')::int as failed,
      coalesce(sum(o.quantity),0)::int as units,
      max(r.secured_at) as "lastSecuredAt",max(o.confirmed_at) as "lastConfirmedAt",
      (select count(*)::int from reservations where run_id=${run.runId}) as reservations,
      (select count(*)::int from simulated_notifications where run_id=${run.runId}) as notifications,
      (select count(*)::int from erp_dispatch_calls where run_id=${run.runId} and resolved_at is null) as unresolved,
      (select count(*)::int from order_recovery_jobs c join orders oo on oo.id=c.order_id where oo.run_id=${run.runId} and c.status='escalated') as escalated,
      (select count(*)::int from erp_confirmation_ledger where run_id=${run.runId}) as "erpLedger",
      (select count(*)::int from order_events where run_id=${run.runId}) as events
    from orders o join reservations r on r.id=o.reservation_id where o.run_id=${run.runId}`;
  const counters =
    await sql`select process,counts from proof_counters where run_id=${run.runId} order by process`;
  const stock = run.snapshot.inventoryConfig.startingStock;
  return {
    run,
    observedAt: new Date().toISOString(),
    business,
    counters,
    correctness: {
      noOversell: business.units <= stock,
      oneOrderPerReservation: business.orders === business.reservations,
      settled:
        business.queued === 0 &&
        business.processing === 0 &&
        business.unresolved === 0 &&
        business.escalated === 0,
      notificationsComplete: business.notifications === business.confirmed,
      erpConfirmedAgreement: business.erpLedger === business.confirmed,
    },
  };
}

export async function finishRun(sql, run, reset = false) {
  await withRunFence(sql, run.runId, async (session) => {
    await session`update proof_runs set closed=true,generation=generation+1 where run_id=${run.runId}`;
    await session`update demo_runs set status=${reset ? "failed" : "completed"},
      failure_reason=${reset ? "admin_reset" : null},finalized_at=now() where id=${run.runId}`;
  });
}

export async function teardownRun(connection, run, reset = false) {
  if (reset)
    await purgeResetRunDurable(connection.db, { runId: run.runId, failureReason: "admin_reset" });
  const result = await deleteGeneratedRunDurable(connection.db, run);
  if (result.outcome !== "deleted") throw new Error(`Teardown refused: ${result.outcome}`);
}

export async function startController(config = configuration(), env = process.env) {
  const connection = db.createDatabaseConnection(config.databaseUrl, { max: 3 });
  const app = fastify({ loggerInstance: logger, disableRequestLogging: true });
  authorize(app, config.token);
  let run = null;
  let children = [];
  let busy = false;
  const request = async (port, path, method = "GET") => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "x-lab-token": config.token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${port}${path}: ${response.status}`);
    return response.json();
  };
  const spawn = (file, extra) => {
    const child = fork(new URL(file, import.meta.url), [], {
      env: { ...env, ...extra },
      stdio: "inherit",
    });
    children.push(child);
    return child;
  };
  const stopChildren = async () => {
    const current = children;
    children = [];
    await Promise.all(
      current.map(async (child) => {
        if (child.exitCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  };
  const ready = async (port, path = "/health") => {
    for (let n = 0; n < 200; n++) {
      try {
        if ((await request(port, path)).ready !== false) return;
      } catch {}
      if (children.some((c) => c.exitCode !== null))
        throw new Error("A lab process exited during startup.");
      await sleep(100);
    }
    throw new Error(`Lab startup timed out on ${port}.`);
  };
  app.get("/health", async () => ({
    ready: true,
    run,
    processes: children.map((c) => ({ pid: c.pid, exitCode: c.exitCode })),
  }));
  app.get("/cpu", async () => {
    const processes = [process.pid, ...children.map((child) => child.pid)].map((pid) => {
      try {
        const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
        return {
          pid,
          userTicks: Number(fields[11]),
          systemTicks: Number(fields[12]),
          rssPages: Number(fields[21]),
        };
      } catch {
        return { pid, missing: true };
      }
    });
    return {
      observedAt: new Date().toISOString(),
      processes,
      ...(await readCgroupSample()),
    };
  });
  app.get("/rtt", async () => request(4400, "/rtt"));
  app.post("/setup", async () => {
    if (run) throw new Error("A run is active.");
    await setupDatabase(config);
    return { setup: true };
  });
  app.post("/runs", async (requestBody, reply) => {
    if (busy || run) return reply.code(409).send({ code: "run_active" });
    busy = true;
    try {
      run = await createRun(connection.sql, requestBody.body.mode, requestBody.body.snapshot);
      spawn("../../apps/mock-erp/dist/index.js", {
        HOST: "127.0.0.1",
        PORT: "4100",
        NODE_ENV: "production",
        MOCK_ERP_POSTGRES_POOL_MAX: String(config.poolMax),
      });
      await ready(4100, "/health/ready");
      spawn("authority.mjs", { LAB_MODE: run.mode });
      await ready(4400);
      for (let index = 0; index < config.apiCount; index++)
        spawn("api.mjs", {
          LAB_MODE: run.mode,
          LAB_API_INDEX: String(index),
          PORT: String(4001 + index),
        });
      for (let index = 0; index < config.apiCount; index++) await ready(4001 + index);
      return run;
    } finally {
      busy = false;
    }
  });
  app.get("/snapshot", async () => {
    if (!run) return { run: null };
    for (let index = 0; index < config.apiCount; index++) await request(4001 + index, "/metrics");
    const inventory = await request(4400, "/inventory");
    return { ...(await snapshotRun(connection.sql, run)), inventory };
  });
  app.post("/reconcile-uncertain", async () => request(4400, "/reconcile-uncertain", "POST"));
  app.post("/finish", async (requestBody, reply) => {
    if (busy || !run) return reply.code(409).send({ code: "no_run" });
    busy = true;
    const reset = requestBody.body?.reset === true;
    try {
      const evidence = await snapshotRun(connection.sql, run);
      if (!reset && !Object.values(evidence.correctness).every(Boolean))
        return reply.code(409).send(evidence);
      for (let index = 0; index < config.apiCount; index++)
        await request(4001 + index, "/close", "POST");
      await request(4400, "/reset", "POST");
      await finishRun(connection.sql, run, reset);
      await stopChildren();
      await teardownRun(connection, run, reset);
      const previous = run;
      run = null;
      return { evidence, deleted: previous.runId };
    } finally {
      busy = false;
    }
  });
  await app.listen({ host: env.HOST ?? "::", port: Number(env.PORT ?? 4500) });
  return {
    app,
    connection,
    close: async () => {
      await stopChildren();
      await app.close();
      await connection.close();
    },
  };
}

if (isMain(import.meta.url)) {
  const controller = await startController();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void controller.close().then(() => process.exit(0)));
}
