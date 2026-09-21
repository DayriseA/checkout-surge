// @vitest-environment jsdom

import type { DemoRunSnapshot } from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { GracePeriodNotice } from "../src/app/components/grace-period-notice.js";

describe("grace period notice", () => {
  afterEach(cleanup);

  it("stays hidden before 600 seconds after acceptance", () => {
    const { container } = render(
      createElement(GracePeriodNotice, {
        run: runFixture("active"),
        now: () => clock("2026-06-20T00:09:59.000Z"),
      }),
    );

    expect(container.querySelector("[data-grace-period-notice]")).toBeNull();
  });

  it("appears from 600 seconds after acceptance with the time left until the reset", () => {
    const { container } = render(
      createElement(GracePeriodNotice, {
        run: runFixture("active"),
        now: () => clock("2026-06-20T00:10:00.000Z"),
      }),
    );

    const notice = container.querySelector("[data-grace-period-notice]");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("grace period");
    expect(notice?.textContent).toContain("reset automatically in 5 min");
    expect(notice?.textContent).toContain("free the demo");
    expect(notice?.textContent).toContain("run data will be discarded");
  });

  it("updates the remaining time under the same run data and stays visible across a reconnect re-render", () => {
    // The notice derives only from the server-owned deadline plus the clock: a new projection
    // after an SSE reconnect, or a full page reload, reproduces the same notice without stored
    // client state.
    const { container, rerender } = render(
      createElement(GracePeriodNotice, {
        run: runFixture("active"),
        now: () => clock("2026-06-20T00:12:00.000Z"),
      }),
    );
    expect(container.querySelector("[data-grace-period-notice]")?.textContent).toContain(
      "reset automatically in 3 min",
    );

    rerender(
      createElement(GracePeriodNotice, {
        run: runFixture("active"),
        now: () => clock("2026-06-20T00:14:30.000Z"),
      }),
    );
    expect(container.querySelector("[data-grace-period-notice]")?.textContent).toContain(
      "reset automatically in 30 s",
    );
  });

  it("stays hidden for terminal runs and runs without a server-owned deadline", () => {
    for (const status of ["completed", "failed"] as const) {
      const { container } = render(
        createElement(GracePeriodNotice, {
          run: runFixture(status),
          now: () => clock("2026-06-20T00:14:00.000Z"),
        }),
      );
      expect(container.querySelector("[data-grace-period-notice]")).toBeNull();
    }

    // Terminal snapshots keep a meaningless `autoResetAt`; only its absence on a nonterminal
    // run suppresses the notice here.
    const { container } = render(
      createElement(GracePeriodNotice, {
        run: runFixture("active", { autoResetAt: undefined }),
        now: () => clock("2026-06-20T00:14:00.000Z"),
      }),
    );
    expect(container.querySelector("[data-grace-period-notice]")).toBeNull();
  });
});

function clock(iso: string): number {
  return Date.parse(iso);
}

function runFixture(
  status: "active" | "completed" | "failed",
  overrides: Partial<DemoRunSnapshot> = {},
): DemoRunSnapshot {
  const base = {
    runId: "11111111-1111-4111-8111-111111111111",
    presetId: "22222222-2222-4222-8222-222222222222",
    presetName: "Preview 1k",
    operatorMode: "public" as const,
    saleOfferId: "33333333-3333-4333-8333-333333333333",
    configSnapshot: previewRunConfigSnapshotFixture(),
    startedAt: "2026-06-20T00:00:00.000Z",
    autoResetAt: "2026-06-20T00:15:00.000Z",
  };
  if (status === "completed") {
    return {
      ...base,
      status,
      trafficStatus: "succeeded",
      trafficStartedAt: base.startedAt,
      trafficEndedAt: "2026-06-20T00:05:00.000Z",
      finalizedAt: "2026-06-20T00:05:01.000Z",
      ...overrides,
    } as DemoRunSnapshot;
  }
  if (status === "failed") {
    return {
      ...base,
      status,
      trafficStatus: "failed",
      trafficStartedAt: base.startedAt,
      trafficEndedAt: "2026-06-20T00:05:00.000Z",
      finalizedAt: "2026-06-20T00:05:01.000Z",
      failureCategory: "operator" as const,
      ...overrides,
    } as DemoRunSnapshot;
  }
  return {
    ...base,
    status,
    trafficStatus: "active",
    trafficStartedAt: base.startedAt,
    ...overrides,
  } as DemoRunSnapshot;
}
