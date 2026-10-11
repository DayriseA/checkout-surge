import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ChaosConfirmationDecisionProvider } from "../../apps/mock-erp/dist/application/chaos-control-service.js";
import { ConfirmationService } from "../../apps/mock-erp/dist/application/confirmation-service.js";
import { SlidingWindowTpsLimiter } from "../../apps/mock-erp/dist/application/tps-limiter.js";
import { PostgresConfirmationLedger } from "../../apps/mock-erp/dist/persistence/postgres-confirmation-ledger.js";
import { buildMockErpServer } from "../../apps/mock-erp/dist/server.js";
import { resetTestDatabase } from "../../packages/db/dist/testing.js";
import { startBuyer } from "./api.mjs";
import { startAuthority } from "./authority.mjs";
import { contracts, db, logger, sleep } from "./common.mjs";
import { createRun, finishRun, setupDatabase, snapshotRun, teardownRun } from "./controller.mjs";
import { PostgresOrderQueue } from "./postgres.mjs";
import { collectDrainedEvidence, validity } from "./run-matrix.mjs";

const config = {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: direct Node test, outside Turborepo caching.
  databaseUrl: process.env.TEST_DATABASE_URL,
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: direct Node test, outside Turborepo caching.
  redisUrl: process.env.TEST_REDIS_URL,
  token: "isolated-feasibility-tests",
  poolMax: 2,
  apiCount: 2,
  inlineDeadlineMs: 2000,
  erpUrl: "http://127.0.0.1:4100",
  authorityUrl: "http://127.0.0.1:4400",
};
let connection;
let erp;
const baseline = () => {
  const preset = db.buildSeedPresets().find((p) => p.slug === "preview-1k");
  return contracts.acceptedRunConfigSnapshotSchema.parse({
    trafficConfig: preset.trafficConfig,
    inventoryConfig: { startingStock: 8 },
    erpConfig: { ...preset.erpConfig, latencyMs: 0, maxTps: 1000, errorRate: 0 },
    backpressureConfig: { ...preset.backpressureConfig, orderProcessConcurrency: 2 },
  });
};

before(async () => {
  assert.ok(config.databaseUrl, "Dedicated TEST_DATABASE_URL is required.");
  assert.ok(config.redisUrl, "Dedicated TEST_REDIS_URL is required.");
  await resetTestDatabase({ databaseUrl: config.databaseUrl });
  await setupDatabase(config);
  connection = db.createDatabaseConnection(config.databaseUrl, { max: 3 });
  erp = buildMockErpServer({
    confirmationService: new ConfirmationService({
      decisionProvider: new ChaosConfirmationDecisionProvider({
        tpsLimiter: new SlidingWindowTpsLimiter(),
      }),
      ledger: new PostgresConfirmationLedger(connection.sql),
    }),
    logger,
    startedAt: new Date(),
  });
  await erp.listen({ host: "127.0.0.1", port: 4100 });
});
after(async () => {
  const closing = erp?.close();
  erp?.server.closeAllConnections();
  await closing;
  await connection?.close();
});

async function fixture(mode, snapshot = baseline(), override = {}) {
  const run = await createRun(connection.sql, mode, snapshot);
  const options = { ...config, ...override };
  const authority = await startAuthority(options, { LAB_MODE: mode }, override.processingOptions);
  const buyers = [];
  for (let index = 0; index < 2; index++)
    buyers.push(
      await startBuyer(options, {
        LAB_MODE: mode,
        LAB_API_INDEX: String(index),
        PORT: String(4001 + index),
      }),
    );
  return {
    run,
    authority,
    buyers,
    async close(reset = false) {
      await authority.app.inject({
        method: "POST",
        url: "/reset",
        headers: { "x-lab-token": config.token },
      });
      await finishRun(connection.sql, run, reset);
      for (const buyer of buyers) await buyer.close();
      await authority.close();
      await teardownRun(connection, run, reset);
    },
  };
}
const request = (run, key = randomUUID(), quantity = 1) => ({
  runId: run.runId,
  saleOfferId: run.saleOfferId,
  quantity,
  idempotencyKey: key,
});
async function buy(buyer, body) {
  const response = await buyer.app.inject({
    method: "POST",
    url: "/buy",
    headers: { "x-lab-token": config.token },
    payload: body,
  });
  return { status: response.statusCode, body: response.json() };
}
async function settled(run, expected) {
  for (let n = 0; n < 400; n++) {
    const snapshot = await snapshotRun(connection.sql, run);
    if (
      snapshot.business.confirmed === expected &&
      Object.values(snapshot.correctness).every(Boolean)
    )
      return snapshot;
    await sleep(20);
  }
  throw new Error(`Run did not settle: ${JSON.stringify(await snapshotRun(connection.sql, run))}`);
}

for (const mode of ["demo", "no-redis", "no-queue"])
  test(`${mode}: concurrent stock, cross-process replay/conflict, durable bookkeeping and teardown`, async () => {
    const f = await fixture(mode);
    try {
      const key = randomUUID();
      const twins = await Promise.all(f.buyers.map((buyer) => buy(buyer, request(f.run, key))));
      assert.equal(twins[0].body.reservation.id, twins[1].body.reservation.id);
      const conflict = await buy(f.buyers[1], request(f.run, key, 2));
      assert.equal(conflict.body.outcome, "idempotency_conflict");
      const outcomes = await Promise.all(
        Array.from({ length: 24 }, (_, n) => buy(f.buyers[n % 2], request(f.run))),
      );
      assert.ok(outcomes.some((r) => r.body.outcome === "sold_out"));
      const evidence = await settled(f.run, 8);
      assert.equal(evidence.business.orders, 8);
      assert.equal(evidence.business.notifications, 8);
      if (mode === "no-queue") {
        assert.equal(twins[0].status, 200);
        assert.equal(twins[0].body.outcome, "order_confirmed");
        assert.equal(twins[0].body.order.status, "confirmed");
      }
    } finally {
      await f.close(true);
    }
    const [rows] = await connection.sql`select (select count(*) from proof_holds)::int as holds,
    (select count(*) from proof_queue)::int as queue,(select count(*) from proof_runs)::int as runs`;
    assert.deepEqual(rows, { holds: 0, queue: 0, runs: 0 });
  });

test("PostgreSQL acceptance and publication share a pool of one; queue leases recover", async () => {
  const f = await fixture("no-redis", baseline(), { poolMax: 1 });
  try {
    const results = await Promise.race([
      Promise.all(Array.from({ length: 16 }, (_, n) => buy(f.buyers[n % 2], request(f.run)))),
      sleep(5000).then(() => {
        throw new Error("Admission session checkout deadlocked.");
      }),
    ]);
    assert.equal(results.length, 16);
    await settled(f.run, 8);
    await connection.sql`insert into proof_queue(order_id,run_id,job)
      select id,run_id,'{}'::jsonb from orders where run_id=${f.run.runId} limit 1`;
    // Pause the public consumer before claiming its next delivery.
    await f.authority.app.inject({
      method: "POST",
      url: "/reset",
      headers: { "x-lab-token": config.token },
    });
    const queue = new PostgresOrderQueue(connection.sql, 30);
    const first = await queue.claim();
    assert.ok(first);
    assert.equal(await queue.claim(), null);
    await sleep(40);
    const second = await queue.claim();
    assert.equal(second.generation, first.generation + 1);
    await queue.settle(first); // stale owner cannot acknowledge the new generation
    const [row] =
      await connection.sql`select generation from proof_queue where order_id=${second.order_id}`;
    assert.equal(row.generation, second.generation);
    await queue.settle(second);
  } finally {
    await f.close(true);
  }
});

for (const mode of ["demo", "no-redis", "no-queue"])
  test(`${mode}: a closed run rejects replay and new traffic`, async () => {
    const f = await fixture(mode);
    try {
      const body = request(f.run);
      await buy(f.buyers[0], body);
      await f.authority.app.inject({
        method: "POST",
        url: "/reset",
        headers: { "x-lab-token": config.token },
      });
      await finishRun(connection.sql, f.run, true);
      const replay = await buy(f.buyers[1], body);
      const fresh = await buy(f.buyers[0], request(f.run));
      assert.equal(replay.body.outcome, "run_not_accepting_traffic");
      assert.equal(fresh.body.outcome, "run_not_accepting_traffic");
    } finally {
      await f.close(true);
    }
  });

test("inline deadline before ERP dispatch persists a failed order without holding admission", async () => {
  const snapshot = baseline();
  snapshot.inventoryConfig.startingStock = 2;
  snapshot.erpConfig.maxTps = 1;
  snapshot.erpConfig.latencyMs = 0;
  snapshot.backpressureConfig.orderProcessConcurrency = 1;
  const f = await fixture("no-queue", snapshot, { poolMax: 1, inlineDeadlineMs: 150 });
  try {
    const results = await Promise.all(f.buyers.map((buyer) => buy(buyer, request(f.run))));
    assert.ok(results.some((r) => r.body.outcome === "confirmation_failed"));
    const evidence = await snapshotRun(connection.sql, f.run);
    assert.equal(evidence.business.processing, 0);
    assert.equal(evidence.business.unresolved, 0);
    assert.equal(evidence.business.orders, 2);
    assert.equal(evidence.business.failed + evidence.business.confirmed, 2);
  } finally {
    await f.close(true);
  }
});

test("inline ERP 401 persists a terminal technical failure", async () => {
  const f = await fixture("no-queue", baseline(), {
    inlineDeadlineMs: 150,
    processingOptions: {
      fetchRequest: async () =>
        new Response(
          JSON.stringify({
            status: "failed",
            httpStatus: 401,
            errorCode: "erp_authentication_failed",
            errorMessage: "Authentication rejected",
            latencyMs: 0,
            timestamp: new Date().toISOString(),
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    },
  });
  try {
    const result = await buy(f.buyers[0], request(f.run));
    assert.equal(result.body.outcome, "confirmation_failed");
    const evidence = await snapshotRun(connection.sql, f.run);
    assert.equal(evidence.business.failed, 1);
    assert.equal(evidence.business.processing, 0);
    assert.equal(evidence.business.unresolved, 0);
  } finally {
    await f.close(true);
  }
});

test("lost ERP success response reconciles through the real ledger without a second side effect", async () => {
  let lost = false;
  const f = await fixture("no-queue", baseline(), {
    processingOptions: {
      fetchRequest: async (url, options) => {
        const response = await fetch(url, options);
        if (options.method === "POST" && response.ok && !lost) {
          lost = true;
          await response.arrayBuffer();
          throw new TypeError("Connection lost after ERP commit.");
        }
        return response;
      },
    },
  });
  try {
    const result = await buy(f.buyers[0], request(f.run));
    assert.equal(result.body.outcome, "confirmation_unresolved");
    const before = await snapshotRun(connection.sql, f.run);
    assert.equal(before.business.unresolved, 1);
    assert.equal(before.correctness.settled, false);
    const recovered = await f.authority.app.inject({
      method: "POST",
      url: "/reconcile-uncertain",
      headers: { "x-lab-token": config.token },
    });
    assert.equal(recovered.statusCode, 200);
    const evidence = await settled(f.run, 1);
    assert.equal(evidence.business.erpLedger, 1);
    assert.equal(evidence.business.unresolved, 0);
  } finally {
    await f.close(true);
  }
});

test("post-deadline unknown lookup preserves uncertainty without a new ERP POST", async () => {
  let posts = 0;
  const f = await fixture("no-queue", baseline(), {
    inlineDeadlineMs: 150,
    processingOptions: {
      fetchRequest: async (url, options) => {
        if (options.method === "POST") {
          posts++;
          if (posts === 1)
            throw new TypeError("Connection failed before the ERP received dispatch.");
        }
        return fetch(url, options);
      },
    },
  });
  try {
    const result = await buy(f.buyers[0], request(f.run));
    assert.equal(result.body.outcome, "confirmation_unresolved");
    assert.equal(posts, 1);
    const recovered = await f.authority.app.inject({
      method: "POST",
      url: "/reconcile-uncertain",
      headers: { "x-lab-token": config.token },
    });
    assert.equal(recovered.statusCode, 200);
    assert.equal(posts, 1, "A lookup-only endpoint must never replay an unknown result.");
    assert.equal(recovered.json().reconciled, 0);
    const evidence = await snapshotRun(connection.sql, f.run);
    assert.equal(evidence.business.erpLedger, 0);
    assert.equal(evidence.business.confirmed, 0);
    assert.equal(evidence.business.unresolved, 1);
    assert.equal(evidence.business.escalated, 1);
    assert.equal(evidence.correctness.settled, false);
  } finally {
    await f.close(true);
  }
});

for (const releaseBeforeDeadline of [true, false])
  test(`collector ${releaseBeforeDeadline ? "waits for a fresh notification-complete snapshot" : "keeps a missing notification invalid at deadline"}`, async () => {
    const f = await fixture("demo");
    const lock = await connection.sql.reserve();
    let locked = false;
    try {
      await lock`begin`;
      await lock`lock table simulated_notifications in share mode`;
      locked = true;
      const accepted = await buy(f.buyers[0], request(f.run));
      assert.equal(accepted.body.outcome, "reservation_secured");
      let intermediate;
      for (let n = 0; n < 100; n++) {
        intermediate = await snapshotRun(connection.sql, f.run);
        if (intermediate.business.confirmed === 1) break;
        await sleep(10);
      }
      assert.equal(intermediate.business.confirmed, 1);
      assert.equal(intermediate.business.notifications, 0);
      assert.equal(intermediate.correctness.settled, true);
      assert.equal(intermediate.correctness.notificationsComplete, false);
      let blockedInserts = 0;
      for (let n = 0; n < 100; n++) {
        const [waiting] = await connection.sql`select count(*)::int as inserts from pg_stat_activity
          where wait_event_type='Lock' and query like '%insert into "simulated_notifications"%'`;
        blockedInserts = waiting.inserts;
        if (blockedInserts > 0) break;
        await sleep(10);
      }
      assert.equal(blockedInserts, 1, "The real notification INSERT must be blocked.");

      const snapshots = [];
      let collected = false;
      const deadline = Date.now() + (releaseBeforeDeadline ? 5000 : 500);
      const collecting = collectDrainedEvidence(async (path) => {
        assert.equal(path, "/snapshot");
        const snapshot = await snapshotRun(connection.sql, f.run);
        snapshots.push(snapshot);
        return snapshot;
      }, deadline).then((snapshot) => {
        collected = true;
        return snapshot;
      });
      await sleep(30);
      assert.ok(snapshots.length > 0);
      assert.equal(collected, false, "Settled orders alone cannot end collection.");
      if (releaseBeforeDeadline) {
        await lock`rollback`;
        locked = false;
        const final = await collecting;
        assert.ok(snapshots.length >= 2);
        assert.equal(final.business.notifications, 1);
        assert.equal(final.business.events, intermediate.business.events + 1);
        assert.ok(Object.values(final.correctness).every(Boolean));
      } else {
        const expired = await collecting;
        assert.ok(Date.now() > deadline);
        assert.equal(expired.business.notifications, 0);
        assert.equal(expired.correctness.notificationsComplete, false);
        assert.equal(
          validity(
            f.run,
            {
              started: 1,
              completed: 1,
              outcomes: { reservation_secured: 1 },
              invalidAttribution: 0,
            },
            expired,
            2,
          ).business,
          false,
        );
      }
    } finally {
      if (locked) await lock`rollback`;
      lock.release();
      await settled(f.run, 1);
      await f.close(true);
    }
  });

test("reset during inline ERP prevents stale durable confirmation", async () => {
  const snapshot = baseline();
  snapshot.erpConfig.latencyMs = 300;
  const f = await fixture("no-queue", snapshot);
  try {
    const pending = buy(f.buyers[0], request(f.run));
    for (let n = 0; n < 100; n++) {
      const [row] =
        await connection.sql`select count(*)::int as calls from erp_dispatch_calls where run_id=${f.run.runId}`;
      if (row.calls) break;
      await sleep(5);
    }
    await f.authority.app.inject({
      method: "POST",
      url: "/reset",
      headers: { "x-lab-token": config.token },
    });
    await finishRun(connection.sql, f.run, true);
    const result = await pending;
    assert.notEqual(result.body.outcome, "order_confirmed");
    await sleep(350);
    const evidence = await snapshotRun(connection.sql, f.run);
    assert.equal(evidence.business.confirmed, 0);
    assert.equal(evidence.business.notifications, 0);
  } finally {
    await f.close(true);
  }
});
