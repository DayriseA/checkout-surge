import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as contracts from "../../packages/contracts/dist/index.js";
import * as db from "../../packages/db/dist/index.js";
import { createServiceLogger } from "../../packages/logger/dist/index.js";

export { contracts, db };
export const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url));
export const workerRequire = createRequire(
  new URL("../../apps/worker/package.json", import.meta.url),
);
export const fastify = apiRequire("fastify").default;
export const logger = createServiceLogger({ service: "api" }).child({ experiment: "feasibility" });
export const sleep = (ms, signal) =>
  import("node:timers/promises").then(({ setTimeout }) => setTimeout(ms, undefined, { signal }));

export function configuration(env = process.env) {
  if (env.FEASIBILITY_LAB !== "true") throw new Error("FEASIBILITY_LAB=true is required.");
  if (!env.DATABASE_URL || !env.LAB_TOKEN) throw new Error("Lab database and token are required.");
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    token: env.LAB_TOKEN,
    poolMax: Number(env.LAB_POOL_MAX ?? 10),
    apiCount: Number(env.LAB_API_COUNT ?? 3),
    inlineDeadlineMs: Number(env.LAB_INLINE_DEADLINE_MS ?? 60_000),
    erpUrl: env.LAB_ERP_URL ?? "http://127.0.0.1:4100",
    authorityUrl: env.LAB_AUTHORITY_URL ?? "http://127.0.0.1:4400",
  };
}

export function authorize(app, token) {
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers["x-lab-token"] !== token) {
      return reply.code(401).send({ code: "unauthorized" });
    }
  });
}

export function isMain(url) {
  return process.argv[1] && url === pathToFileURL(process.argv[1]).href;
}

export function toJob(persisted) {
  const { order, reservation } = persisted;
  return contracts.orderProcessJobSchema.parse({
    orderId: order.id,
    publicOrderId: order.publicOrderId,
    reservationId: reservation.id,
    saleOfferId: order.saleOfferId,
    runId: order.runId,
    correlationId: order.correlationId,
    quantity: order.quantity,
    queuedAt: order.queuedAt,
    processingGeneration: 0,
  });
}

export async function activeRun(sql) {
  const [row] = await sql`
    select l.run_id as "runId", r.sale_offer_id as "saleOfferId", l.mode, l.generation,
      r.config_snapshot as snapshot, l.closed
    from proof_runs l join demo_runs r on r.id = l.run_id where not l.closed limit 1`;
  return row ?? null;
}
