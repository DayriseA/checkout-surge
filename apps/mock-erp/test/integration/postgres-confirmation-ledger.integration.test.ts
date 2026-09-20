import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  type ErpConfirmationRequest,
  erpConfirmationLookupPath,
  erpConfirmationPath,
  erpLookupResponseSchema,
  erpReplayedResponseHeaderName,
} from "@checkout-surge/contracts";
import { createDatabaseConnection } from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConfirmationIdempotencyConflictError,
  ConfirmationService,
} from "../../src/application/confirmation-service.js";
import { PostgresConfirmationLedger } from "../../src/persistence/postgres-confirmation-ledger.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const migrationsFolder = new URL("../../../../packages/db/drizzle", import.meta.url).pathname;
const mockErpRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockErpEntryPoint = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const request: ErpConfirmationRequest = {
  orderId: "81000000-0000-4000-8000-000000000001",
  publicOrderId: "ord-ledger-integration",
  reservationId: "81000000-0000-4000-8000-000000000002",
  saleOfferId: "81000000-0000-4000-8000-000000000003",
  runId: "81000000-0000-4000-8000-000000000004",
  idempotencyKey: "erp-confirmation:81000000-0000-4000-8000-000000000001",
  correlationId: "corr-ledger-integration",
  quantity: 1,
};

run("PostgreSQL confirmation ledger", () => {
  const connections: Array<ReturnType<typeof createDatabaseConnection>> = [];
  const runtimes: MockErpProcess[] = [];
  const connect = () => {
    const connection = createDatabaseConnection(databaseUrl ?? "", { max: 2 });
    connections.push(connection);
    return connection;
  };

  beforeAll(async () => {
    await resetTestDatabase({ migrationsFolder });
  });

  afterAll(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.close("SIGKILL")));
    await Promise.all(connections.map((connection) => connection.close()));
  });

  it("lets the unique insert choose one canonical winner and rejects identity contradictions", async () => {
    const first = connect();
    const second = connect();
    const firstService = new ConfirmationService({
      ledger: new PostgresConfirmationLedger(first.sql),
      generateConfirmationId: () => "erp-confirmation-winner-a",
      now: () => new Date("2026-09-20T00:00:00.010Z"),
    });
    const secondService = new ConfirmationService({
      ledger: new PostgresConfirmationLedger(second.sql),
      generateConfirmationId: () => "erp-confirmation-winner-b",
      now: () => new Date("2026-09-20T00:00:00.020Z"),
    });

    const uppercaseRequest = {
      ...request,
      orderId: "A1000000-0000-4000-8000-000000000001",
      reservationId: "B1000000-0000-4000-8000-000000000002",
      saleOfferId: "C1000000-0000-4000-8000-000000000003",
      runId: "D1000000-0000-4000-8000-000000000004",
      idempotencyKey: "erp-confirmation:uppercase-identity",
    };
    const results = await Promise.all([
      firstService.confirm(uppercaseRequest),
      secondService.confirm(uppercaseRequest),
    ]);

    expect(results[0]?.response).toEqual(results[1]?.response);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    await expect(firstService.confirm(uppercaseRequest)).resolves.toMatchObject({ replayed: true });
    await expect(
      secondService.confirm({ ...uppercaseRequest, quantity: 2 }),
    ).rejects.toBeInstanceOf(ConfirmationIdempotencyConflictError);
    const rows = await first.sql<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM erp_confirmation_ledger
      WHERE idempotency_key = ${uppercaseRequest.idempotencyKey}
    `;
    expect(rows[0]?.count).toBe(1);
  });

  it("returns byte-identical canonical JSON through replay and lookup after a service restart", async () => {
    const restartRequest = {
      ...request,
      orderId: "82000000-0000-4000-8000-000000000001",
      publicOrderId: "ord-ledger-restart",
      reservationId: "82000000-0000-4000-8000-000000000002",
      idempotencyKey: "erp-confirmation:82000000-0000-4000-8000-000000000001",
    };
    const initial = await startMockErpProcess(runtimes);
    const accepted = await fetch(`${initial.baseUrl}${erpConfirmationPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(restartRequest),
    });
    const canonicalBody = await accepted.text();
    expect(accepted.status).toBe(200);
    await initial.close();

    const restarted = await startMockErpProcess(runtimes, { forcedOutage: true });
    const replay = await fetch(`${restarted.baseUrl}${erpConfirmationPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...restartRequest, correlationId: "corr-after-restart" }),
    });
    const replayBody = await replay.text();
    const lookup = await fetch(
      `${restarted.baseUrl}${erpConfirmationLookupPath.replace(
        ":idempotencyKey",
        encodeURIComponent(restartRequest.idempotencyKey),
      )}`,
    );
    const lookupResult = erpLookupResponseSchema.parse(await lookup.json());
    await restarted.close();

    expect(replay.headers.get(erpReplayedResponseHeaderName)).toBe("true");
    expect(replayBody).toBe(canonicalBody);
    expect(lookupResult.lookup.status).toBe("succeeded");
    if (lookupResult.lookup.status === "succeeded") {
      expect(JSON.stringify(lookupResult.lookup.result)).toBe(canonicalBody);
    }
  });

  it("recovers a discarded terminal response through lookup and replay", async () => {
    const lostResponseRequest = {
      ...request,
      orderId: "83000000-0000-4000-8000-000000000001",
      publicOrderId: "ord-ledger-lost-response",
      reservationId: "83000000-0000-4000-8000-000000000002",
      idempotencyKey: "erp-confirmation:83000000-0000-4000-8000-000000000001",
    };
    const runtime = await startMockErpProcess(runtimes);

    await discardResponse(`${runtime.baseUrl}${erpConfirmationPath}`, lostResponseRequest);

    const lookup = await fetch(
      `${runtime.baseUrl}${erpConfirmationLookupPath.replace(
        ":idempotencyKey",
        encodeURIComponent(lostResponseRequest.idempotencyKey),
      )}`,
    );
    const lookupResult = erpLookupResponseSchema.parse(await lookup.json());
    const replay = await fetch(`${runtime.baseUrl}${erpConfirmationPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(lostResponseRequest),
    });
    const replayBody = await replay.text();
    await runtime.close();

    expect(lookupResult.lookup.status).toBe("succeeded");
    expect(replay.headers.get(erpReplayedResponseHeaderName)).toBe("true");
    if (lookupResult.lookup.status === "succeeded") {
      expect(replayBody).toBe(JSON.stringify(lookupResult.lookup.result));
    }
  });

  it("leaves unknown and no terminal row when killed during latency before insertion", async () => {
    const crashRequest = {
      ...request,
      orderId: "84000000-0000-4000-8000-000000000001",
      publicOrderId: "ord-ledger-pre-insert-crash",
      reservationId: "84000000-0000-4000-8000-000000000002",
      idempotencyKey: "erp-confirmation:84000000-0000-4000-8000-000000000001",
    };
    const crashing = await startMockErpProcess(runtimes, { latencyMs: 5000 });
    const pendingRequest = fetch(`${crashing.baseUrl}${erpConfirmationPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(crashRequest),
    }).catch(() => undefined);

    await crashing.waitForOutput("Mock ERP confirmation request received.");
    await crashing.close("SIGKILL");
    await pendingRequest;

    const restarted = await startMockErpProcess(runtimes);
    const lookup = await fetch(
      `${restarted.baseUrl}${erpConfirmationLookupPath.replace(
        ":idempotencyKey",
        encodeURIComponent(crashRequest.idempotencyKey),
      )}`,
    );
    const lookupResult = erpLookupResponseSchema.parse(await lookup.json());
    await restarted.close();
    const connection = connect();
    const rows = await connection.sql<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM erp_confirmation_ledger
      WHERE idempotency_key = ${crashRequest.idempotencyKey}
    `;

    expect(lookupResult.lookup.status).toBe("unknown");
    expect(rows[0]?.count).toBe(0);
  });
});

interface MockErpProcess {
  baseUrl: string;
  close(signal?: NodeJS.Signals): Promise<void>;
  waitForOutput(text: string): Promise<void>;
}

async function startMockErpProcess(
  runtimes: MockErpProcess[],
  options: { forcedOutage?: boolean; latencyMs?: number } = {},
): Promise<MockErpProcess> {
  const port = await availablePort();
  const child = spawn(process.execPath, ["--import", "tsx", mockErpEntryPoint], {
    cwd: mockErpRoot,
    env: {
      ...process.env,
      NODE_ENV: "development",
      DATABASE_URL: databaseUrl,
      CONTROL_SERVICE_TOKEN: "integration-control-token",
      HOST: "127.0.0.1",
      PORT: String(port),
      LOG_LEVEL: "info",
      LATENCY_MS: String(options.latencyMs ?? 0),
      MAX_TPS: "100",
      ERROR_RATE: "0",
      FORCED_OUTAGE: String(options.forcedOutage ?? false),
      ADMIN_MAX_LATENCY_MS: "5000",
      ADMIN_MIN_MAX_TPS: "1",
      ADMIN_MAX_ERROR_RATE: "1",
      ADMIN_ALLOW_FORCED_OUTAGE: "true",
      MOCK_ERP_POSTGRES_POOL_MAX: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = once(child, "exit");
  let closed = false;
  const runtime: MockErpProcess = {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async (signal = "SIGTERM") => {
      if (closed) return;
      closed = true;
      child.kill(signal);
      await exited;
    },
    waitForOutput: async (text) => {
      await waitUntil(
        () => output.includes(text),
        child,
        () => output,
      );
    },
  };
  runtimes.push(runtime);
  await waitUntil(
    async () => {
      try {
        return (await fetch(`${runtime.baseUrl}/health/ready`)).ok;
      } catch {
        return false;
      }
    },
    child,
    () => output,
  );
  return runtime;
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  child: ChildProcess,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Mock ERP test process exited early.\n${diagnostics()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Mock ERP test process.\n${diagnostics()}`);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  return address.port;
}

async function discardResponse(url: string, payload: ErpConfirmationRequest): Promise<void> {
  const body = JSON.stringify(payload);
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.destroy();
        resolve();
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}
