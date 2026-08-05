import { controlServiceTokenHeaderName } from "@checkout-surge/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readAdminReadiness } from "../src/app/lib/server/admin-reads.js";
import {
  initializeWebServerConfig,
  resetWebServerConfigForTests,
} from "../src/app/lib/server/config.js";

afterEach(() => {
  resetWebServerConfigForTests();
  vi.unstubAllGlobals();
});

describe("protected admin readiness read", () => {
  it("retains canonical probe details server-side without public BFF sanitization", async () => {
    initializeWebServerConfig({
      API_BASE_URL: "http://api.internal",
      MOCK_ERP_BASE_URL: "http://mock-erp.internal",
      CONTROL_SERVICE_TOKEN: "control-token",
      ADMIN_DASHBOARD_PASSPHRASE: "admin-passphrase",
      ADMIN_SESSION_SECRET: "session-secret",
      PUBLIC_CLIENT_COOKIE_SECRET: "visitor-cookie-secret",
      WEB_ORIGIN: "http://dashboard.local",
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get(controlServiceTokenHeaderName)).toBe("control-token");
      return new Response(
        JSON.stringify({
          service: "api",
          status: "unavailable",
          timestamp: "2026-06-20T00:00:10.000Z",
          uptimeSeconds: 10,
          checks: [
            {
              name: "database_reachable",
              status: "unavailable",
              message: "PostgreSQL readiness check failed.",
            },
          ],
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const read = await readAdminReadiness();

    expect(read).toMatchObject({
      status: "available",
      data: {
        checks: [
          {
            name: "database_reachable",
            message: "PostgreSQL readiness check failed.",
          },
        ],
      },
    });
  });
});
