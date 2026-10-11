import { createBullMqOrderProcessJobPublisher } from "../../apps/api/dist/queue/bullmq-order-process-job-publisher.js";
import { createOrderRecoveryScanner } from "../../apps/worker/dist/application/order-recovery-scanner.js";
import { PostgresGeneratedRunPublicationFence } from "../../apps/worker/dist/persistence/postgres-generated-run-publication-fence.js";
import { createBullMqOrderProcessConsumer } from "../../apps/worker/dist/queue/bullmq-order-process-consumer.js";
import { createBullMqOrderProcessJobPublisher as createRecoveryPublisher } from "../../apps/worker/dist/queue/bullmq-order-process-job-publisher.js";
import {
  activeRun,
  authorize,
  configuration,
  contracts,
  db,
  fastify,
  isMain,
  logger,
  sleep,
  workerRequire,
} from "./common.mjs";
import { enqueuePostgres, PostgresOrderQueue, PostgresStockReservations } from "./postgres.mjs";
import { createProcessing } from "./processing.mjs";

export async function startAuthority(
  config = configuration(),
  env = process.env,
  processingOptions,
) {
  const connection = db.createDatabaseConnection(config.databaseUrl, { max: config.poolMax });
  const run = await activeRun(connection.sql);
  if (!run || run.mode !== env.LAB_MODE) throw new Error("Authority mode mismatch.");
  const redis = run.mode === "no-redis" ? null : db.createRedisClient(config.redisUrl);
  if (redis)
    await db.initializeInventory(redis, {
      saleOfferId: run.saleOfferId,
      allocatedStock: run.snapshot.inventoryConfig.startingStock,
      run: { runId: run.runId, status: "accepting" },
    });
  const processing = await createProcessing(connection, run, config, processingOptions);
  const pgQueue = new PostgresOrderQueue(connection.sql);
  let closed = false;
  let working = 0;
  const concurrency = run.snapshot.backpressureConfig.orderProcessConcurrency;
  const bull =
    run.mode === "demo"
      ? createBullMqOrderProcessJobPublisher({ url: config.redisUrl, maxRetriesPerRequest: 3 })
      : null;
  if (bull)
    await bull.setLimits({
      concurrency,
      ...contracts.erpDispatchRateLimit(run.snapshot.erpConfig.maxTps),
    });
  const consumer = bull
    ? createBullMqOrderProcessConsumer({
        connection: { url: config.redisUrl, maxRetriesPerRequest: null },
        concurrency,
        handler: { handle: (job, delivery) => processing.execute(job, delivery) },
        logger,
        recovery: processing.recovery,
        closeDeadlineMs: 5000,
      })
    : null;
  consumer?.start();
  const recoveryPublisher = bull
    ? createRecoveryPublisher(
        { url: config.redisUrl, maxRetriesPerRequest: 3 },
        new PostgresGeneratedRunPublicationFence(connection.db),
      )
    : null;
  const recoveryScanner = recoveryPublisher
    ? createOrderRecoveryScanner({
        persistence: processing.recovery,
        handler: { handle: (job, delivery) => processing.execute(job, delivery) },
        publisher: recoveryPublisher,
        deliveryStateReader: recoveryPublisher,
        failedJobReader: recoveryPublisher,
        logger,
        scanIntervalMs: 1000,
        batchSize: 100,
        recoveryLeaseMs: 30_000,
      })
    : null;
  recoveryScanner?.start();

  const claimDelivery = async (job, fallback) => {
    const control = await processing.recovery.readControlRecord({ orderId: job.orderId });
    if (!control) return { job, delivery: fallback };
    if (control.status === "resolved") return { job, delivery: fallback };
    const claim = await processing.recovery.claimForPublication({
      recoveryKey: control.recoveryKey,
      now: new Date(),
      leaseMs: 30_000,
    });
    if (!claim) return null;
    return {
      job: { ...job, processingGeneration: claim.processingGeneration },
      delivery: {
        attemptNumber: claim.attempt,
        attemptsMade: claim.attempt - 1,
        deliveryId: claim.jobId,
        processingGeneration: claim.processingGeneration,
        recoveryKey: control.recoveryKey,
      },
    };
  };
  const queueLoop = async () => {
    while (!closed) {
      if (working >= concurrency) {
        await sleep(10);
        continue;
      }
      const claim = await pgQueue.claim();
      if (!claim) {
        await sleep(10);
        continue;
      }
      working++;
      void (async () => {
        const heartbeat = setInterval(
          () =>
            void pgQueue
              .renew(claim)
              .catch((error) => logger.error({ error }, "PG lease renewal failed.")),
          5000,
        );
        try {
          const owned = await claimDelivery(claim.job, {
            attemptNumber: claim.attempts,
            attemptsMade: claim.attempts - 1,
            deliveryId: claim.order_id,
          });
          if (!owned) {
            await pgQueue.settle(claim, new Date(Date.now() + 1000));
            return;
          }
          const result = await processing.execute(owned.job, owned.delivery);
          await pgQueue.settle(
            claim,
            ["confirmed", "failed"].includes(result?.status) ? null : new Date(Date.now() + 1000),
          );
        } catch (error) {
          logger.error({ error }, "Experimental PG delivery failed.");
          await pgQueue.settle(claim, new Date(Date.now() + 1000));
        } finally {
          clearInterval(heartbeat);
          working--;
        }
      })();
    }
  };
  const loop = run.mode === "no-redis" ? queueLoop() : null;
  const app = fastify({ loggerInstance: logger, disableRequestLogging: true });
  authorize(app, config.token);
  app.get("/health", async () => ({ ready: !closed, mode: run.mode }));
  app.get("/rtt", async () => {
    const samples = { postgres: [], redis: [] };
    for (let n = 0; n < 30; n++) {
      let at = performance.now();
      await connection.sql`select 1`;
      samples.postgres.push(performance.now() - at);
      if (redis) {
        at = performance.now();
        await redis.ping();
        samples.redis.push(performance.now() - at);
      }
    }
    return samples;
  });
  app.get("/inventory", async () => {
    if (redis) return db.getInventoryStatus(redis, run.saleOfferId);
    const [inventory] =
      await connection.sql`select * from proof_inventory where run_id=${run.runId}`;
    return inventory;
  });
  app.post("/inline", async (request, reply) => {
    const { job: raw, generation } = request.body;
    const job = contracts.orderProcessJobSchema.parse(raw);
    if (
      closed ||
      run.mode !== "no-queue" ||
      generation !== run.generation ||
      job.runId !== run.runId ||
      job.saleOfferId !== run.saleOfferId
    ) {
      return reply.code(409).send({ code: "run_closed" });
    }
    const result = await processing.execute(
      job,
      { attemptNumber: 1, attemptsMade: 0, deliveryId: job.orderId },
      config.inlineDeadlineMs,
    );
    return reply
      .code(result?.status === "confirmed" ? 200 : 504)
      .send(result ?? { code: "order_missing" });
  });
  app.post("/reset", async () => {
    closed = true;
    if (redis)
      await db.setRunSaleEligibility(redis, {
        runId: run.runId,
        saleOfferId: run.saleOfferId,
        status: "closed",
      });
    processing.reset();
    return { closed: true };
  });

  // Only reconcile already dispatched uncertain calls in no-queue mode; never send a
  // first ERP request for an ordinary undispatched order after its buyer has left.
  app.post("/reconcile-uncertain", async () => {
    const rows = await connection.sql`select c.payload as job from order_recovery_jobs c
      join erp_dispatch_calls e on e.id=c.unresolved_erp_call_id
      where e.run_id=${run.runId} and e.resolved_at is null and c.status='escalated' limit 20`;
    let reconciled = 0;
    for (const { job } of rows) {
      await connection.sql`update order_recovery_jobs set status='pending',next_attempt_at=now(),
        lease_expires_at=null where order_id=${job.orderId} and status='escalated'`;
      const owned = await claimDelivery(job, {
        attemptNumber: 1,
        attemptsMade: 0,
        deliveryId: job.orderId,
      });
      if (owned) {
        const result = await processing.execute(owned.job, owned.delivery, 15_000, {
          lookupOnly: run.mode === "no-queue",
        });
        if (["confirmed", "failed"].includes(result?.status)) reconciled++;
      }
    }
    return { reconciled };
  });
  let maintenanceBusy = false;
  const maintenance = setInterval(() => {
    if (maintenanceBusy || closed || run.mode === "no-queue") return;
    maintenanceBusy = true;
    void (async () => {
      const pending = redis
        ? (
            await db.readPendingPersistencePage(redis, { saleOfferId: run.saleOfferId, limit: 20 })
          ).records.map((r) => ({ reservation: r, idempotencyKey: r.idempotencyKey }))
        : await new PostgresStockReservations(connection.sql).pending(run);
      for (const { reservation, idempotencyKey } of pending) {
        await fetch("http://127.0.0.1:4001/recover", {
          method: "POST",
          headers: { "content-type": "application/json", "x-lab-token": config.token },
          body: JSON.stringify({
            runId: run.runId,
            saleOfferId: run.saleOfferId,
            quantity: reservation.quantity,
            idempotencyKey,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      }
      // Durable accepted rows are the outbox backstop if publication failed after commit.
      const queued =
        await connection.sql`select o.* from orders o where run_id=${run.runId} and status='queued' and queued_at<now()-interval '2 seconds' limit 100`;
      for (const row of queued) {
        const job = contracts.orderProcessJobSchema.parse({
          orderId: row.id,
          publicOrderId: row.public_order_id,
          reservationId: row.reservation_id,
          saleOfferId: row.sale_offer_id,
          runId: row.run_id,
          correlationId: row.correlation_id,
          quantity: row.quantity,
          queuedAt: new Date(row.queued_at).toISOString(),
          processingGeneration: 0,
        });
        if (bull) await bull.enqueue(job);
        else await enqueuePostgres(connection.sql, job);
      }
    })()
      .catch((error) => logger.error({ error }, "Experimental recovery pass failed."))
      .finally(() => {
        maintenanceBusy = false;
      });
  }, 1000);
  await app.listen({ host: "127.0.0.1", port: 4400 });
  return {
    app,
    run,
    connection,
    processing,
    close: async () => {
      closed = true;
      clearInterval(maintenance);
      processing.reset();
      await recoveryScanner?.close();
      await consumer?.close();
      await loop;
      await processing.close();
      while (working || maintenanceBusy) await sleep(10);
      await app.close();
      await bull?.close();
      await recoveryPublisher?.close();
      if (bull) {
        const { Queue } = workerRequire("bullmq");
        const cleanup = new Queue(contracts.orderProcessBullMqQueueName, {
          connection: { url: config.redisUrl },
        });
        await cleanup.obliterate({ force: true });
        await cleanup.close();
      }
      if (redis) await db.deleteGeneratedRunRedisState(redis, run);
      await redis?.quit();
      await connection.close();
    },
  };
}

if (isMain(import.meta.url)) {
  const runtime = await startAuthority();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void runtime.close().then(() => process.exit(0)));
}
