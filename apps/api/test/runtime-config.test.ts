import { describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/runtime/config.js";

const baseEnv = {
  DATABASE_URL: "postgresql://localhost/test",
  REDIS_URL: "redis://localhost:6379",
};

describe("API runtime configuration", () => {
  it.each([
    undefined,
    "  ",
    "change-me-shared-control-token",
  ])("rejects unsafe control tokens (%s)", (token) => {
    expect(() => loadApiConfig({ ...baseEnv, CONTROL_SERVICE_TOKEN: token })).toThrow(
      /CONTROL_SERVICE_TOKEN/,
    );
  });

  it("accepts a deployment-specific control token", () => {
    expect(
      loadApiConfig({ ...baseEnv, CONTROL_SERVICE_TOKEN: "deployment-token" }).controlServiceToken,
    ).toBe("deployment-token");
  });
});
