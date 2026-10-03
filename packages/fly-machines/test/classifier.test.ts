import { describe, expect, it } from "vitest";
import {
  classifyFlyError,
  classifyFlyMachine,
  type FlyFailureClass,
  FlyMachinesApiError,
} from "../src/index.js";

function apiError(status: number, body: unknown): FlyMachinesApiError {
  return new FlyMachinesApiError(
    "POST",
    "/machines/m1/start",
    status,
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

describe("classifyFlyError", () => {
  it.each<[string, FlyMachinesApiError, FlyFailureClass]>([
    [
      "create: insufficient_capacity (422)",
      apiError(422, { error: "no capacity", status: "insufficient_capacity" }),
      "provider_capacity",
    ],
    [
      "create: volume_placement_capacity (412)",
      apiError(412, { error: "no room", status: "volume_placement_capacity" }),
      "provider_capacity",
    ],
    ...[
      "insufficient CPUs available to fulfill request",
      "insufficient memory available to fulfill request",
      "insufficient IPs available",
      "insufficient resources available to fulfill request",
      "could not reserve resource for machine: insufficient CPUs available",
      "governor policy blocked start",
      "deploys to this host are temporarily disabled, please try again later",
      "failed to launch VM: region cdg has no capacity",
    ].map(
      (phrase) =>
        [`start: 409 "${phrase}"`, apiError(409, { error: phrase }), "provider_capacity"] as [
          string,
          FlyMachinesApiError,
          FlyFailureClass,
        ],
    ),
    [
      "start: 409 phrase in a plain-text body",
      apiError(409, "could not reserve resource for machine"),
      "provider_capacity",
    ],
    ["408", apiError(408, { error: "deadline_exceeded" }), "host_unreachable"],
    [
      'host_status: "unreachable"',
      apiError(503, { error: "host down", host_status: "unreachable" }),
      "host_unreachable",
    ],
    ["429", apiError(429, { error: "rate limited" }), "transient"],
    ["500", apiError(500, { error: "internal" }), "transient"],
    ["503", apiError(503, "service unavailable"), "transient"],
    [
      "409 lease conflict",
      apiError(409, { error: "lease currently held by someone else" }),
      "conflict",
    ],
    ["409 version conflict", apiError(409, { error: "machine version mismatch" }), "conflict"],
    ["other 4xx (400)", apiError(400, { error: "invalid config" }), "own_error"],
    ["other 4xx (404)", apiError(404, { error: "machine not found" }), "own_error"],
    ["other 4xx (422 without a capacity status)", apiError(422, { error: "bad" }), "own_error"],
    ["anything else from Fly (3xx)", apiError(302, ""), "unclassified_provider_error"],
  ])("%s", (_signal, error, expected) => {
    expect(classifyFlyError(error)).toBe(expected);
  });

  it("leaves a failure that is not a Fly answer unclassified", () => {
    expect(classifyFlyError(new TypeError("fetch failed"))).toBe("unclassified_provider_error");
  });
});

describe("classifyFlyMachine", () => {
  it("classifies a dead or unreachable host", () => {
    expect(classifyFlyMachine({ host_status: "unreachable", events: [] })).toBe("host_unreachable");
  });

  it("classifies a non-zero exit after start as our own error", () => {
    expect(
      classifyFlyMachine({
        host_status: "ok",
        events: [
          { type: "exit", request: { exit_event: { exit_code: 1 } } },
          { type: "start", status: "started" },
        ],
      }),
    ).toBe("own_error");
  });

  it("ignores a clean exit, a requested stop and a running Machine", () => {
    expect(
      classifyFlyMachine({
        host_status: "ok",
        events: [{ type: "exit", request: { exit_event: {} } }],
      }),
    ).toBeNull();
    expect(
      classifyFlyMachine({
        host_status: "ok",
        events: [
          { type: "exit", request: { exit_event: { exit_code: 137, requested_stop: true } } },
        ],
      }),
    ).toBeNull();
    expect(classifyFlyMachine({ host_status: "ok", events: [{ type: "start" }] })).toBeNull();
  });
});
