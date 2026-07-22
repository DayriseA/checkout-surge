import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { OperationDeadlineExceededError } from "../src/runtime/operation-lifecycle.js";
import { DashboardRecoveryAdmissionService } from "../src/services/dashboard-recovery-admission.js";
import type { DashboardRecoveryService } from "../src/services/dashboard-recovery-service.js";
import { DashboardRecoveryWorkflow } from "../src/services/dashboard-recovery-workflow.js";

describe("dashboard recovery workflow cancellation", () => {
  it("bounds a never-settling admission and returns its pending permit", async () => {
    let admissionAttempt = 0;
    const admission = createAdmission(async () => {
      admissionAttempt += 1;
      return admissionAttempt === 1 ? await new Promise<never>(() => undefined) : "allowed";
    });
    const recovery = { getRecovery: vi.fn() } as unknown as DashboardRecoveryService;
    const workflow = new DashboardRecoveryWorkflow({ admission, recovery });
    const controller = new AbortController();
    const resultPromise = workflow.recover(input(controller.signal));

    controller.abort(new OperationDeadlineExceededError(50));

    await expect(resultPromise).resolves.toEqual({ outcome: "timed_out" });
    expect(recovery.getRecovery).not.toHaveBeenCalled();
    await expect(admission.admit("later")).resolves.toMatchObject({ outcome: "admitted" });
  });

  it("releases three abandoned permits exactly once and later recovers successfully", async () => {
    const admission = createAdmission(async () => "allowed");
    const pending = new Promise<never>(() => undefined);
    const healthyResponse = recoveryFixture();
    const getRecovery = vi
      .fn<DashboardRecoveryService["getRecovery"]>()
      .mockImplementationOnce(async () => pending)
      .mockImplementationOnce(async () => pending)
      .mockImplementationOnce(async () => pending)
      .mockResolvedValueOnce(healthyResponse);
    const workflow = new DashboardRecoveryWorkflow({
      admission,
      recovery: { getRecovery } as unknown as DashboardRecoveryService,
    });
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const abandoned = controllers.map((controller, index) =>
      workflow.recover(input(controller.signal, `source-${index}`)),
    );
    await vi.waitFor(() => expect(getRecovery).toHaveBeenCalledTimes(3));

    await expect(
      workflow.recover(input(new AbortController().signal, "at-capacity")),
    ).resolves.toEqual({ outcome: "at_capacity" });

    for (const controller of controllers) controller.abort(new Error("client disconnected"));
    await expect(Promise.all(abandoned)).resolves.toEqual(
      Array.from({ length: 3 }, () => ({ outcome: "client_disconnected" })),
    );

    await expect(workflow.recover(input(new AbortController().signal, "healthy"))).resolves.toEqual(
      { outcome: "recovered", response: healthyResponse },
    );
  });

  it("releases once when non-cooperative recovery setup or cleanup never settles", async () => {
    const release = vi.fn();
    const admission = {
      admit: vi.fn(async () => ({ outcome: "admitted" as const, release })),
    };
    const workflow = new DashboardRecoveryWorkflow({
      admission,
      recovery: {
        getRecovery: async () => await new Promise<never>(() => undefined),
      } as unknown as DashboardRecoveryService,
    });
    const controller = new AbortController();
    const result = workflow.recover(input(controller.signal));

    controller.abort(new OperationDeadlineExceededError(50));

    await expect(result).resolves.toEqual({ outcome: "timed_out" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("settles an abort/completion race deterministically and releases once", async () => {
    const release = vi.fn();
    const admission = {
      admit: vi.fn(async () => ({ outcome: "admitted" as const, release })),
    };
    let resolveRecovery!: (value: ReturnType<typeof recoveryFixture>) => void;
    const recoveryPromise = new Promise<ReturnType<typeof recoveryFixture>>((resolve) => {
      resolveRecovery = resolve;
    });
    const workflow = new DashboardRecoveryWorkflow({
      admission,
      recovery: {
        getRecovery: async () => recoveryPromise,
      } as unknown as DashboardRecoveryService,
    });
    const controller = new AbortController();
    const result = workflow.recover(input(controller.signal));

    controller.abort(new OperationDeadlineExceededError(50));
    resolveRecovery(recoveryFixture());

    await expect(result).resolves.toEqual({ outcome: "timed_out" });
    expect(release).toHaveBeenCalledOnce();
  });
});

function createAdmission(
  admit: () => Promise<"allowed" | "global" | "source">,
): DashboardRecoveryAdmissionService {
  return new DashboardRecoveryAdmissionService({
    store: { admit },
    maxConcurrent: 3,
    globalMax: 10,
    perSourceMax: 10,
    windowSeconds: 60,
    logger: createSilentLogger("api"),
  });
}

function input(signal: AbortSignal, sourceKey = "source") {
  return { sourceKey, correlationId: "workflow-correlation", signal };
}

function recoveryFixture() {
  return {
    correlationId: "workflow-correlation",
    scope: null,
    recoveredAt: "2026-07-18T00:00:00.000Z",
    currentRun: null,
    inventory: null,
    queue: null,
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
    transportAttemptCounts: null,
    recentMetrics: [],
    recentCompletionOutcomes: [],
  };
}
