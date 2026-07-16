import { randomUUID } from "node:crypto";
import type { ErpConfirmationRequest, ErpConfirmationResponse } from "@checkout-surge/contracts";
import { createDatabaseConnection } from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ConfirmationIdempotencyConflictError,
  ConfirmationService,
} from "../../src/application/confirmation-service.js";
import { PostgresConfirmationLedger } from "../../src/application/postgres-confirmation-ledger.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run("PostgreSQL ERP confirmation ledger", () => {
  const connection = databaseUrl ? createDatabaseConnection(databaseUrl, { max: 4 }) : null;
  const requireConnection = () => {
    if (!connection) throw new Error("TEST_DATABASE_URL is required for integration tests.");
    return connection;
  };
  const orderId = "11111111-1111-4111-8111-111111111111";
  const keyPrefix = `integration:${randomUUID()}`;
  const request: ErpConfirmationRequest = {
    orderId,
    publicOrderId: "ord_ledger_integration",
    reservationId: "22222222-2222-4222-8222-222222222222",
    saleOfferId: "33333333-3333-4333-8333-333333333333",
    idempotencyKey: `${keyPrefix}:replay`,
    correlationId: "corr-ledger-integration",
    quantity: 1,
  };
  const response: ErpConfirmationResponse = {
    status: "succeeded",
    confirmationId: "erp-ledger-confirmation",
    httpStatus: 200,
    latencyMs: 0,
    timestamp: "2026-06-22T00:00:00.000Z",
  };

  beforeAll(async () => {
    await resetTestDatabase({
      databaseUrl: databaseUrl ?? "",
      migrationsFolder: "../../packages/db/drizzle",
    });
    await requireConnection()
      .sql`delete from erp_confirmation_results where idempotency_key like ${`${keyPrefix}:%`}`;
  });
  afterEach(async () => {
    await requireConnection()
      .sql`delete from erp_confirmation_results where idempotency_key like ${`${keyPrefix}:%`}`;
  });
  afterAll(async () => requireConnection().close());

  it("replays the committed result after constructing a fresh service", async () => {
    const first = new ConfirmationService({
      ledger: new PostgresConfirmationLedger(requireConnection().db),
      decisionProvider: { decide: async () => ({ status: "succeeded" }) },
      generateConfirmationId: () => "erp-ledger-confirmation",
      now: () => new Date(response.timestamp),
    });
    await expect(first.confirm(request)).resolves.toEqual(response);
    const restarted = new ConfirmationService({
      ledger: new PostgresConfirmationLedger(requireConnection().db),
      generateConfirmationId: () => "different",
    });
    await expect(restarted.confirm(request)).resolves.toEqual(response);
  });

  it("rejects an immutable request contradiction", async () => {
    const service = new ConfirmationService({
      ledger: new PostgresConfirmationLedger(requireConnection().db),
      generateConfirmationId: () => "erp-ledger-confirmation",
    });
    await service.confirm(request);
    await expect(service.confirm({ ...request, quantity: 2 })).rejects.toBeInstanceOf(
      ConfirmationIdempotencyConflictError,
    );
  });

  it("converges concurrent duplicates to one produced confirmation", async () => {
    let produced = 0;
    const concurrentRequest = { ...request, idempotencyKey: `${keyPrefix}:concurrent` };
    const decisionProvider = {
      decide: async () => {
        produced += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { status: "succeeded" as const };
      },
    };
    const serviceA = new ConfirmationService({
      ledger: new PostgresConfirmationLedger(requireConnection().db),
      decisionProvider,
      generateConfirmationId: () => "concurrent-confirmation",
      now: () => new Date(response.timestamp),
    });
    const serviceB = new ConfirmationService({
      ledger: new PostgresConfirmationLedger(requireConnection().db),
      decisionProvider,
      generateConfirmationId: () => "different-concurrent-confirmation",
      now: () => new Date(response.timestamp),
    });
    const results = await Promise.all([
      serviceA.confirm(concurrentRequest),
      serviceB.confirm(concurrentRequest),
    ]);
    expect(produced).toBe(1);
    expect(results[0]).toEqual(results[1]);
  });

  it("does not cache failed ERP outcomes", async () => {
    let decisions = 0;
    const failedThenSuccessRequest = { ...request, idempotencyKey: `${keyPrefix}:failure-retry` };
    const service = new ConfirmationService({
      ledger: new PostgresConfirmationLedger(requireConnection().db),
      decisionProvider: {
        decide: async () => {
          decisions += 1;
          return decisions === 1
            ? {
                status: "failed" as const,
                httpStatus: 503,
                errorCode: "TEMPORARY",
                errorMessage: "try again",
              }
            : { status: "succeeded" as const };
        },
      },
      generateConfirmationId: () => "failure-retry-confirmation",
      now: () => new Date(response.timestamp),
    });
    await expect(service.confirm(failedThenSuccessRequest)).resolves.toMatchObject({
      status: "failed",
    });
    await expect(service.confirm(failedThenSuccessRequest)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(decisions).toBe(2);
  });
});
