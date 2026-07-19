import {
  createDatabaseConnection,
  createRedisClient,
  promoteReservationIdempotencyToAccepted,
  reverseReservation,
} from "@checkout-surge/db";
import { createSilentLogger } from "@checkout-surge/logger";
import { createBullMqOrderProcessJobPublisher } from "../queue/bullmq-order-process-job-publisher.js";
import { PostgresRunRetryPolicyResolver } from "../queue/postgres-run-retry-policy-resolver.js";
import { PendingPersistenceReconciler } from "../services/pending-persistence-reconciler.js";
import { PendingPersistenceRemediationService } from "../services/pending-persistence-remediation-service.js";
import { PostgresBuyPersistence } from "../services/postgres-buy-persistence.js";

const auditedTargets = [
  {
    runId: "8da8a364-00ed-4732-8e03-399e17b9db4d",
    saleOfferId: "e38749c5-3550-4dee-977a-8718374adec1",
  },
  {
    runId: "598023fd-b68b-46c2-bf24-d13d0096a39f",
    saleOfferId: "5bbdecb8-f7c9-4358-8d96-4e66a60c3723",
  },
] as const;

const apply = process.argv.includes("--apply");
const databaseUrl = requireEnvironment("DATABASE_URL");
const redisUrl = requireEnvironment("REDIS_URL");
const idempotencyTtlSeconds = parsePositiveInteger(process.env.IDEMPOTENCY_TTL_SECONDS, 1_800);
const connection = createDatabaseConnection(databaseUrl, { max: 2 });
const redis = createRedisClient(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
const queuePublisher = createBullMqOrderProcessJobPublisher({
  url: redisUrl,
  maxRetriesPerRequest: 3,
});
const persistence = new PostgresBuyPersistence(connection.db);
const logger = createSilentLogger("api");
const reconciler = new PendingPersistenceReconciler({
  redis,
  persistence,
  stockReservations: {
    promoteAccepted: (input) =>
      promoteReservationIdempotencyToAccepted(redis, input).then(() => undefined),
    reverse: (input) => reverseReservation(redis, input),
  },
  orderProcessJobPublisher: queuePublisher,
  runRetryPolicyResolver: new PostgresRunRetryPolicyResolver(connection.db),
  idempotencyTtlSeconds,
  logger,
  batchSize: 100,
});
const remediation = new PendingPersistenceRemediationService({
  db: connection.db,
  redis,
  persistence,
  reconciler,
  maxRecordsPerTarget: 1_000,
  batchSize: 100,
});

try {
  const inspections = [];
  for (const target of auditedTargets) inspections.push(await remediation.inspect(target));
  process.stdout.write(
    `${JSON.stringify({ mode: apply ? "apply" : "dry-run", inspections }, null, 2)}\n`,
  );

  if (apply) {
    if (inspections.some((inspection) => !inspection.safeToApply)) {
      throw new Error("At least one target failed inspection; no target was mutated.");
    }
    const results = [];
    for (const target of auditedTargets) results.push(await remediation.apply(target));
    process.stdout.write(`${JSON.stringify({ mode: "apply-complete", results }, null, 2)}\n`);
  }
} finally {
  await queuePublisher.close();
  redis.disconnect();
  await connection.close();
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("IDEMPOTENCY_TTL_SECONDS must be a positive safe integer.");
  }
  return parsed;
}
