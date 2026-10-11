import { publicVisitorIdHeaderName } from "@checkout-surge/contracts";
import {
  publicVisitorCookieName,
  signPublicVisitorCredential,
} from "@checkout-surge/contracts/public-visitor-credential";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getComparisonDetail } from "../src/app/lib/api.js";
import {
  initializeWebServerConfig,
  resetWebServerConfigForTests,
} from "../src/app/lib/server/config.js";
import {
  comparisonFixture,
  comparisonId,
  missingComparisonResponse,
} from "./comparison-fixtures.js";

const getCookie = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ cookies: async () => ({ get: getCookie }) }));
afterEach(() => {
  resetWebServerConfigForTests();
  vi.unstubAllGlobals();
  getCookie.mockReset();
});

beforeEach(() => {
  initializeWebServerConfig({
    API_BASE_URL: "http://api.internal",
    CONTROL_SERVICE_TOKEN: "control-token",
    ADMIN_DASHBOARD_PASSPHRASE: "admin-passphrase",
    ADMIN_SESSION_SECRET: "session-secret",
    PUBLIC_CLIENT_COOKIE_SECRET: "visitor-cookie-secret",
    WEB_ORIGIN: "http://dashboard.local",
  });
});

it("preserves canonical absence for both server-loaded comparison entries", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() => Promise.resolve(missingComparisonResponse())),
  );
  expect(await getComparisonDetail(comparisonId)).toEqual({
    status: "unavailable",
    httpStatus: 404,
    errorCode: "resource_not_found",
  });
});

it("keeps SSR and proxy parent reads on the visitor's existing source identity", async () => {
  const credential = signPublicVisitorCredential(
    "visitor-cookie-secret",
    "11111111-1111-4111-8111-111111111111",
    Date.now(),
  );
  getCookie.mockReturnValue({ value: credential });
  const fetchMock = vi.fn().mockResolvedValue(Response.json(comparisonFixture()));
  vi.stubGlobal("fetch", fetchMock);
  const read = await getComparisonDetail(comparisonId);
  expect(read.status).toBe("available");
  expect(getCookie).toHaveBeenCalledWith(publicVisitorCookieName);
  expect(fetchMock).toHaveBeenCalledWith(
    `http://api.internal/demo/comparisons/${comparisonId}`,
    expect.objectContaining({
      cache: "no-store",
      headers: expect.objectContaining({ [publicVisitorIdHeaderName]: credential }),
    }),
  );
});
