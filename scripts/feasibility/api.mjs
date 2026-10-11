import { randomUUID } from "node:crypto";
import { createBullMqOrderProcessJobPublisher } from "../../apps/api/dist/queue/bullmq-order-process-job-publisher.js";
import { ReserveOrderService } from "../../apps/api/dist/services/reserve-order-service.js";
import {
  installFastifyCorrelation,
  replaceFastifyCorrelation,
} from "../../packages/logger/dist/fastify.js";
import {
  activeRun,
  apiRequire,
  authorize,
  configuration,
  contracts,
  db,
  fastify,
  isMain,
  logger,
  toJob,
} from "./common.mjs";
import {
  admissionPersistence,
  enqueuePostgres,
  PostgresStockReservations,
  recoverAcceptance,
} from "./postgres.mjs";

const { z } = apiRequire("zod");
const confirmedResponse = contracts.reservationAcceptedResponseSchema.extend({
  outcome: z.literal("order_confirmed"),
  order: contracts.acceptedOrderSummarySchema.extend({
    status: z.literal("confirmed"),
    confirmedAt: contracts.isoTimestampSchema,
  }),
});
const unsuccessfulResponse = contracts.reservationAcceptedResponseSchema.extend({
  outcome: z.enum(["confirmation_failed", "confirmation_unresolved"]),
  order: contracts.acceptedOrderSummarySchema.extend({ status: contracts.orderStatusSchema }),
  code: z.string().min(1),
});

export async function startBuyer(config = configuration(), env = process.env) {
  const connection = db.createDatabaseConnection(config.databaseUrl, { max: config.poolMax });
  const run = await activeRun(connection.sql);
  if (!run || run.mode !== env.LAB_MODE) throw new Error("Buyer mode does not match active run.");
  // Redis is never constructed in the PostgreSQL-only composition.
  const redis = run.mode === "no-redis" ? null : db.createRedisClient(config.redisUrl);
  const bull =
    run.mode === "demo"
      ? createBullMqOrderProcessJobPublisher({ url: config.redisUrl, maxRetriesPerRequest: 3 })
      : null;
  const stock = redis
    ? {
        reserve: (input) => db.reserveInventoryStock(redis, input),
        markPendingPersistence: (input) => db.markReservationPendingPersistence(redis, input),
        promoteAccepted: (input) => db.promoteReservationIdempotencyToAccepted(redis, input),
        reverse: (input) => db.reverseReservation(redis, input),
      }
    : new PostgresStockReservations(connection.sql);
  const counts = {
    started: 0,
    completed: 0,
    accepted: 0,
    confirmed: 0,
    soldOut: 0,
    failed: 0,
    pending: 0,
  };
  let closed = false;
  const processName = `api-${env.LAB_API_INDEX ?? 0}`;
  let flushing;
  const flush = () => {
    flushing ??= connection.sql`insert into proof_counters(run_id,process,counts)
      values(${run.runId},${processName},${JSON.stringify(counts)}::jsonb)
      on conflict(run_id,process) do update set counts=excluded.counts`.finally(() => {
      flushing = undefined;
    });
    return flushing;
  };
  const timer = setInterval(
    () => void flush().catch((error) => logger.error({ error }, "Counter flush failed.")),
    250,
  );
  timer.unref();
  const app = fastify({ loggerInstance: logger, disableRequestLogging: true });
  installFastifyCorrelation(app);
  authorize(app, config.token);
  app.setErrorHandler((error, _request, reply) => {
    logger.error({ error }, "Experimental buyer request failed.");
    reply
      .code(error.name === "ZodError" ? 400 : 503)
      .send({ code: "request_failed", message: error.message });
  });
  app.get("/health", async () => ({ ready: !closed, mode: run.mode, process: processName }));
  app.get("/metrics", async () => {
    await flush();
    // A periodic write already in flight may have captured an older count snapshot.
    await flush();
    return counts;
  });
  app.post("/close", async () => {
    closed = true;
    await flush();
    return { closed };
  });

  const buy = async (request, reply, recovering = false) => {
    const body = contracts.buyRequestSchema.parse(request.body);
    if (
      request.headers[contracts.loadRunIdHeaderName] &&
      request.headers[contracts.loadRunIdHeaderName] !== body.runId
    ) {
      return reply.code(400).send({ code: "run_header_mismatch" });
    }
    const correlationId = replaceFastifyCorrelation(
      request,
      reply,
      body.correlationId ?? request.correlationId,
    );
    if (!recovering) counts.started++;
    let response;
    try {
      if (closed || body.runId !== run.runId || body.saleOfferId !== run.saleOfferId) {
        response = {
          outcome: "run_not_accepting_traffic",
          correlationId,
          timestamp: new Date().toISOString(),
          reservation: null,
          order: null,
        };
      } else {
        const scope = admissionPersistence(connection.db, (session, job) =>
          run.mode === "no-redis"
            ? enqueuePostgres(session, job)
            : bull
              ? bull.enqueue(job)
              : Promise.resolve(),
        );
        const service = new ReserveOrderService({
          persistence: scope.persistence,
          stockReservations: stock,
          orderProcessJobPublisher: scope.publisher,
          reservationHoldMinutes: 15,
          idempotencyTtlSeconds: 86400,
          pendingPersistenceRetryAfterSeconds: 1,
          pendingPersistenceRecovery: {
            recoverReservation: (input) => recoverAcceptance(scope, stock, input),
          },
          generateId: randomUUID,
        });
        response = await service.reserve({ request: body, correlationId });
        if (run.mode === "no-queue" && response.outcome === "reservation_secured") {
          if (scope.hasAdmissionSession())
            throw new Error("Inline ERP must not hold an admission session.");
          const result = await fetch(`${config.authorityUrl}/inline`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-lab-token": config.token },
            body: JSON.stringify({ job: toJob(response), generation: run.generation }),
            signal: AbortSignal.timeout(config.inlineDeadlineMs + 15_000),
          });
          const final = await result.json();
          if (!result.ok || final.status !== "confirmed") {
            response = {
              outcome:
                final.status === "processing" ? "confirmation_unresolved" : "confirmation_failed",
              correlationId,
              timestamp: new Date().toISOString(),
              reservation: response.reservation,
              order: { ...response.order, status: final.status ?? "failed" },
              code: final.code ?? "inline_deadline",
            };
          } else {
            response = {
              ...response,
              outcome: "order_confirmed",
              order: { ...response.order, status: "confirmed", confirmedAt: final.confirmedAt },
            };
          }
        }
      }
      if (!recovering) {
        if (response.outcome === "reservation_secured") counts.accepted++;
        else if (response.outcome === "order_confirmed") {
          counts.accepted++;
          counts.confirmed++;
        } else if (response.outcome === "sold_out") counts.soldOut++;
        else if (response.outcome === "reservation_pending_persistence") counts.pending++;
        else if (["confirmation_failed", "confirmation_unresolved"].includes(response.outcome))
          counts.failed++;
      }
      if (response.outcome === "order_confirmed") confirmedResponse.parse(response);
      else if (["confirmation_failed", "confirmation_unresolved"].includes(response.outcome))
        unsuccessfulResponse.parse(response);
      else contracts.buyResponseSchema.parse(response);
      reply.header(contracts.buyOutcomeHeaderName, response.outcome);
      return reply
        .code(
          response.outcome === "order_confirmed"
            ? 200
            : response.outcome === "reservation_secured" ||
                response.outcome === "reservation_pending_persistence"
              ? 202
              : ["confirmation_failed", "confirmation_unresolved"].includes(response.outcome)
                ? 504
                : 409,
        )
        .send(response);
    } catch (error) {
      if (!recovering) counts.failed++;
      throw error;
    } finally {
      if (!recovering) counts.completed++;
    }
  };
  app.post("/buy", (request, reply) => buy(request, reply));
  app.post("/recover", (request, reply) => buy(request, reply, true));
  await app.listen({
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 4001),
    backlog: 8192,
  });
  return {
    app,
    run,
    connection,
    stock,
    counts,
    close: async () => {
      closed = true;
      clearInterval(timer);
      await app.close();
      await flush();
      await bull?.close();
      await redis?.quit();
      await connection.close();
    },
  };
}

if (isMain(import.meta.url)) {
  const runtime = await startBuyer();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void runtime.close().then(() => process.exit(0)));
}
