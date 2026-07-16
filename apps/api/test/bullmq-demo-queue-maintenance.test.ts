import {
  notificationRecordBullMqQueueName,
  notificationRecordJobName,
  notificationRecordJobSchema,
  orderProcessBullMqQueueName,
  orderProcessJobName,
  orderProcessJobSchema,
} from "@checkout-surge/contracts";
import { Queue, Worker } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBullMqDemoQueueMaintenance,
  createDemoQueueMaintenance,
  type TargetQueueBoundary,
  type TargetQueueJob,
} from "../src/queue/bullmq-demo-queue-maintenance.js";

const runId = "55555555-5555-4555-8555-555555555554";
const otherRunId = "55555555-5555-4555-8555-555555555555";
const connection = { url: process.env.TEST_REDIS_URL ?? "redis://localhost:6380" };
const resources: Array<{ close(): Promise<void> }> = [];
const restoreOwnedPauses = { disposition: "restore_owned_pauses" } as const;
const maintenancePauseOwnershipSuffix = "checkout-surge:generated-run-maintenance-pause-owned";

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

describe("BullMQ generated-run maintenance", () => {
  it("removes only matching non-active jobs from both physical queues", async () => {
    const orders = new Queue(orderProcessBullMqQueueName, { connection });
    const notifications = new Queue(notificationRecordBullMqQueueName, { connection });
    await Promise.all([
      orders.obliterate({ force: true }),
      notifications.obliterate({ force: true }),
    ]);
    const maintenance = createBullMqDemoQueueMaintenance(connection);
    resources.push(maintenance, orders, notifications);
    await orders.add(orderProcessJobName, orderJob(runId));
    await orders.add(orderProcessJobName, orderJob(otherRunId));
    await notifications.add(notificationRecordJobName, notificationJob(runId), { delay: 60_000 });
    await notifications.add(notificationRecordJobName, notificationJob(otherRunId));

    await expect(maintenance.cleanGeneratedRun?.(runId)).resolves.toEqual({ deletedJobCount: 2 });
    expect((await orders.getJobs(["waiting", "delayed"])).map((job) => job.data.runId)).toEqual([
      otherRunId,
    ]);
    expect(
      (await notifications.getJobs(["waiting", "delayed"])).map((job) => job.data.runId),
    ).toEqual([otherRunId]);
  });

  it("rejects a matching active job without broad deletion", async () => {
    const orders = new Queue(orderProcessBullMqQueueName, { connection });
    await orders.obliterate({ force: true });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new Worker(orderProcessBullMqQueueName, async () => blocked, { connection });
    const maintenance = createBullMqDemoQueueMaintenance(connection);
    resources.push(maintenance, orders, worker);
    await orders.add(orderProcessJobName, orderJob(runId));
    for (let index = 0; index < 50 && (await orders.getActiveCount()) === 0; index += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(maintenance.preflightGeneratedRun?.(runId)).rejects.toMatchObject({
      code: "active_job",
    });
    expect(await orders.getActiveCount()).toBe(1);
    release();
  });

  it("persists maintenance pause ownership across a BullMQ adapter restart", async () => {
    const orders = new Queue(orderProcessBullMqQueueName, { connection });
    const notifications = new Queue(notificationRecordBullMqQueueName, { connection });
    await Promise.all([
      orders.obliterate({ force: true }),
      notifications.obliterate({ force: true }),
    ]);
    resources.push(orders, notifications);

    const firstMaintenance = createBullMqDemoQueueMaintenance(connection);
    const firstLease = await firstMaintenance.acquireGeneratedRunQuiescence?.(runId);
    await firstLease?.release({ disposition: "retain_owned_pauses" });
    await firstMaintenance.close();
    expect(await orders.isPaused()).toBe(true);
    expect(await notifications.isPaused()).toBe(true);
    expect(await (await orders.client).get(orders.toKey(maintenancePauseOwnershipSuffix))).toBe(
      runId,
    );
    expect(
      await (await notifications.client).get(notifications.toKey(maintenancePauseOwnershipSuffix)),
    ).toBe(runId);

    const foreignMaintenance = createBullMqDemoQueueMaintenance(connection);
    await expect(
      foreignMaintenance.acquireGeneratedRunQuiescence?.(otherRunId),
    ).rejects.toMatchObject({ code: "maintenance_owned_by_other_run" });
    await foreignMaintenance.close();
    expect(await orders.isPaused()).toBe(true);
    expect(await notifications.isPaused()).toBe(true);
    expect(await (await orders.client).get(orders.toKey(maintenancePauseOwnershipSuffix))).toBe(
      runId,
    );

    const restartedMaintenance = createBullMqDemoQueueMaintenance(connection);
    resources.push(restartedMaintenance);
    const retryLease = await restartedMaintenance.acquireGeneratedRunQuiescence?.(runId);
    await retryLease?.release(restoreOwnedPauses);
    expect(await orders.isPaused()).toBe(false);
    expect(await notifications.isPaused()).toBe(false);
    expect(
      await (await orders.client).get(orders.toKey(maintenancePauseOwnershipSuffix)),
    ).toBeNull();
    expect(
      await (await notifications.client).get(notifications.toKey(maintenancePauseOwnershipSuffix)),
    ).toBeNull();
  });

  it("removes every supported exact-run state across both queues and preserves foreign/catalog jobs", async () => {
    const states = ["waiting", "delayed", "prioritized", "paused", "failed", "completed"];
    const orders = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    const notifications = new FakeQueue("notifications:record", (data) =>
      notificationRecordJobSchema.parse(data),
    );
    for (const state of states) {
      orders.add(state, orderJob(runId));
      notifications.add(state, notificationJob(runId));
    }
    orders.add("waiting", orderJob(otherRunId));
    notifications.add("completed", notificationJob(undefined));
    const maintenance = createDemoQueueMaintenance([orders, notifications]);

    await expect(maintenance.cleanGeneratedRun?.(runId)).resolves.toEqual({ deletedJobCount: 12 });
    expect(orders.remainingRunIds()).toEqual([otherRunId]);
    expect(notifications.remainingRunIds()).toEqual([undefined]);
  });

  it("preserves malformed claimed-target jobs and reports a conflict", async () => {
    const orders = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    const malformed = orders.add("waiting", { runId });
    const maintenance = createDemoQueueMaintenance([orders]);
    await expect(maintenance.cleanGeneratedRun?.(runId)).rejects.toMatchObject({
      code: "malformed_claimed_job",
    });
    expect(malformed.removed).toBe(false);
  });

  it("reports a state-change-to-active conflict and preserves the job", async () => {
    const orders = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    const job = orders.add("waiting", orderJob(runId));
    job.removeBehavior = async () => {
      orders.move(job, "active");
      throw new Error("claimed");
    };
    const maintenance = createDemoQueueMaintenance([orders]);
    await expect(maintenance.cleanGeneratedRun?.(runId)).rejects.toMatchObject({
      code: "active_job",
    });
    expect(job.removed).toBe(false);
  });

  it("restores only queues paused by the lease and preserves a pre-paused queue", async () => {
    const prePaused = new FakeQueue(
      "orders:process",
      (data) => orderProcessJobSchema.parse(data),
      true,
    );
    const changed = new FakeQueue("notifications:record", (data) =>
      notificationRecordJobSchema.parse(data),
    );
    const maintenance = createDemoQueueMaintenance([prePaused, changed]);
    const lease = await maintenance.acquireGeneratedRunQuiescence?.(runId);
    expect(prePaused.pauseCalls).toBe(0);
    expect(changed.paused).toBe(true);
    await lease?.release(restoreOwnedPauses);
    expect(prePaused.paused).toBe(true);
    expect(prePaused.resumeCalls).toBe(0);
    expect(changed.paused).toBe(false);
  });

  it("serializes overlapping leases until the prior release finishes", async () => {
    const queue = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    const maintenance = createDemoQueueMaintenance([queue]);
    const firstLease = await maintenance.acquireGeneratedRunQuiescence?.(runId);

    let secondResolved = false;
    const secondLeasePromise = maintenance.acquireGeneratedRunQuiescence?.(runId).then((lease) => {
      secondResolved = true;
      return lease;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondResolved).toBe(false);
    expect(queue.pauseCalls).toBe(1);

    let reportResumeStarted: (() => void) | undefined;
    const resumeStarted = new Promise<void>((resolve) => {
      reportResumeStarted = resolve;
    });
    let allowResume: (() => void) | undefined;
    queue.resumeGate = new Promise<void>((resolve) => {
      allowResume = resolve;
    });
    queue.onResume = () => reportResumeStarted?.();
    let reportFinalizationStarted: (() => void) | undefined;
    const finalizationStarted = new Promise<void>((resolve) => {
      reportFinalizationStarted = resolve;
    });
    let allowFinalization: (() => void) | undefined;
    const finalizationGate = new Promise<void>((resolve) => {
      allowFinalization = resolve;
    });
    const firstRelease = firstLease?.release({
      disposition: "restore_owned_pauses",
      afterRestored: async () => {
        reportFinalizationStarted?.();
        await finalizationGate;
      },
    });
    await resumeStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondResolved).toBe(false);
    expect(queue.pauseCalls).toBe(1);

    allowResume?.();
    await finalizationStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondResolved).toBe(false);
    expect(queue.pauseCalls).toBe(1);
    allowFinalization?.();
    await firstRelease;
    const secondLease = await secondLeasePromise;
    expect(secondResolved).toBe(true);
    expect(queue.pauseCalls).toBe(2);
    await secondLease?.release(restoreOwnedPauses);
  });

  it("retains unsafe maintenance pauses and recovers their ownership in a new adapter", async () => {
    const queue = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    const firstMaintenance = createDemoQueueMaintenance([queue]);
    const firstLease = await firstMaintenance.acquireGeneratedRunQuiescence?.(runId);

    let queuedRetryResolved = false;
    const queuedRetryPromise = firstMaintenance
      .acquireGeneratedRunQuiescence?.(runId)
      .then((lease) => {
        queuedRetryResolved = true;
        return lease;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(queuedRetryResolved).toBe(false);

    await firstLease?.release({ disposition: "retain_owned_pauses" });
    const queuedRetry = await queuedRetryPromise;
    expect(queuedRetryResolved).toBe(true);
    expect(queue.paused).toBe(true);
    expect(queue.resumeCalls).toBe(0);
    expect(queue.maintenancePauseOwner).toBe(runId);
    await queuedRetry?.release({ disposition: "retain_owned_pauses" });
    await firstMaintenance.close();

    const foreignMaintenance = createDemoQueueMaintenance([queue]);
    await expect(
      foreignMaintenance.acquireGeneratedRunQuiescence?.(otherRunId),
    ).rejects.toMatchObject({ code: "maintenance_owned_by_other_run" });
    expect(queue.paused).toBe(true);
    expect(queue.resumeCalls).toBe(0);
    expect(queue.maintenancePauseOwner).toBe(runId);
    await foreignMaintenance.close();

    // Recover the safe state even if an operator manually unpaused a marked queue.
    queue.paused = false;
    const restartedMaintenance = createDemoQueueMaintenance([queue]);
    const retryLease = await restartedMaintenance.acquireGeneratedRunQuiescence?.(runId);
    expect(queue.paused).toBe(true);
    expect(queue.pauseCalls).toBe(2);
    await retryLease?.release(restoreOwnedPauses);
    expect(queue.paused).toBe(false);
    expect(queue.resumeCalls).toBe(1);
    expect(queue.maintenancePauseOwner).toBeNull();
  });

  it("rolls back only new claims when a later queue has a foreign owner", async () => {
    const newlyClaimed = new FakeQueue("orders:process", (data) =>
      orderProcessJobSchema.parse(data),
    );
    const foreignOwned = new FakeQueue(
      "notifications:record",
      (data) => notificationRecordJobSchema.parse(data),
      true,
    );
    foreignOwned.maintenancePauseOwner = otherRunId;
    const maintenance = createDemoQueueMaintenance([newlyClaimed, foreignOwned]);

    await expect(maintenance.acquireGeneratedRunQuiescence?.(runId)).rejects.toMatchObject({
      code: "maintenance_owned_by_other_run",
    });
    expect(newlyClaimed.paused).toBe(false);
    expect(newlyClaimed.resumeCalls).toBe(1);
    expect(newlyClaimed.maintenancePauseOwner).toBeNull();
    expect(foreignOwned.paused).toBe(true);
    expect(foreignOwned.resumeCalls).toBe(0);
    expect(foreignOwned.maintenancePauseOwner).toBe(otherRunId);

    const ownerLease = await maintenance.acquireGeneratedRunQuiescence?.(otherRunId);
    await ownerLease?.release(restoreOwnedPauses);
    expect(foreignOwned.paused).toBe(false);
    expect(foreignOwned.maintenancePauseOwner).toBeNull();
  });

  it("does not restore retained pauses when a retry acquisition partially fails", async () => {
    const retained = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    const later = new FakeQueue(
      "notifications:record",
      (data) => notificationRecordJobSchema.parse(data),
      true,
    );
    const maintenance = createDemoQueueMaintenance([retained, later]);
    const firstLease = await maintenance.acquireGeneratedRunQuiescence?.(runId);
    await firstLease?.release({ disposition: "retain_owned_pauses" });

    later.paused = false;
    later.pauseError = new Error("retry pause failed");
    await expect(maintenance.acquireGeneratedRunQuiescence?.(runId)).rejects.toThrow(
      "retry pause failed",
    );
    expect(retained.paused).toBe(true);
    expect(retained.resumeCalls).toBe(0);
    expect(retained.maintenancePauseOwner).toBe(runId);
    expect(later.paused).toBe(false);
    expect(later.maintenancePauseOwner).toBeNull();

    delete later.pauseError;
    const successfulRetry = await maintenance.acquireGeneratedRunQuiescence?.(runId);
    await successfulRetry?.release(restoreOwnedPauses);
    expect(retained.paused).toBe(false);
    expect(later.paused).toBe(false);
  });

  it("retains failed restoration ownership for the next lease retry", async () => {
    const prePaused = new FakeQueue(
      "orders:process",
      (data) => orderProcessJobSchema.parse(data),
      true,
    );
    const owned = new FakeQueue("notifications:record", (data) =>
      notificationRecordJobSchema.parse(data),
    );
    const maintenance = createDemoQueueMaintenance([prePaused, owned]);
    const firstLease = await maintenance.acquireGeneratedRunQuiescence?.(runId);
    owned.resumeError = new Error("resume unavailable");
    await expect(firstLease?.release(restoreOwnedPauses)).rejects.toThrow(
      "Could not fully restore",
    );
    expect(owned.paused).toBe(true);
    expect(owned.resumeCalls).toBe(1);
    expect(prePaused.resumeCalls).toBe(0);

    delete owned.resumeError;
    const retryLease = await maintenance.acquireGeneratedRunQuiescence?.(runId);
    await retryLease?.release(restoreOwnedPauses);
    expect(owned.paused).toBe(false);
    expect(owned.pauseCalls).toBe(1);
    expect(owned.resumeCalls).toBe(2);
    expect(prePaused.paused).toBe(true);
    expect(prePaused.resumeCalls).toBe(0);
  });

  it("rolls back partial pause acquisition and attempts every restoration", async () => {
    const first = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    const second = new FakeQueue("notifications:record", (data) =>
      notificationRecordJobSchema.parse(data),
    );
    second.pauseError = new Error("pause failed");
    const maintenance = createDemoQueueMaintenance([first, second]);
    await expect(maintenance.acquireGeneratedRunQuiescence?.(runId)).rejects.toThrow(
      "pause failed",
    );
    expect(first.paused).toBe(false);
    expect(first.resumeCalls).toBe(1);
    expect(second.paused).toBe(false);
    expect(second.resumeCalls).toBe(1);
    delete second.pauseError;
    const retryLease = await maintenance.acquireGeneratedRunQuiescence?.(runId);
    await retryLease?.release(restoreOwnedPauses);
    expect(first.paused).toBe(false);
    expect(second.paused).toBe(false);

    const third = new FakeQueue("third", (data) => orderProcessJobSchema.parse(data));
    const fourth = new FakeQueue("fourth", (data) => orderProcessJobSchema.parse(data));
    const releaseMaintenance = createDemoQueueMaintenance([third, fourth]);
    const lease = await releaseMaintenance.acquireGeneratedRunQuiescence?.(runId);
    third.resumeError = new Error("resume third");
    fourth.resumeError = new Error("resume fourth");
    await expect(lease?.release(restoreOwnedPauses)).rejects.toMatchObject({
      errors: expect.arrayContaining([third.resumeError, fourth.resumeError]),
    });
    expect(third.resumeCalls).toBe(1);
    expect(fourth.resumeCalls).toBe(1);
  });

  it("waits for an acquired lease before closing and rejects later acquisitions", async () => {
    const queue = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    const maintenance = createDemoQueueMaintenance([queue]);
    const lease = await maintenance.acquireGeneratedRunQuiescence?.(runId);
    let closed = false;
    const closing = maintenance.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(queue.closeCalls).toBe(0);
    await expect(maintenance.acquireGeneratedRunQuiescence?.(runId)).rejects.toThrow(
      "Queue maintenance is closing",
    );

    await lease?.release(restoreOwnedPauses);
    await closing;
    expect(closed).toBe(true);
    expect(queue.closeCalls).toBe(1);
  });
});

function orderJob(attributedRunId?: string) {
  return {
    orderId: crypto.randomUUID(),
    publicOrderId: `order-${crypto.randomUUID()}`,
    reservationId: crypto.randomUUID(),
    saleOfferId: crypto.randomUUID(),
    correlationId: "corr-queue",
    runId: attributedRunId,
    quantity: 1,
    queuedAt: new Date().toISOString(),
  };
}
function notificationJob(attributedRunId?: string) {
  return {
    orderId: crypto.randomUUID(),
    saleOfferId: crypto.randomUUID(),
    correlationId: "corr-queue",
    runId: attributedRunId,
    channel: "email",
    recipientPlaceholder: "buyer@example.invalid",
    confirmedAt: new Date().toISOString(),
  };
}

class FakeJob implements TargetQueueJob {
  readonly id = crypto.randomUUID();
  readonly name = "fake";
  removed = false;
  removeBehavior?: () => Promise<void>;
  constructor(
    readonly data: unknown,
    private readonly owner: FakeQueue,
  ) {}
  async remove() {
    if (this.removeBehavior) return this.removeBehavior();
    this.removed = true;
    this.owner.remove(this);
  }
}

class FakeQueue implements TargetQueueBoundary {
  paused: boolean;
  pauseCalls = 0;
  resumeCalls = 0;
  pauseError?: Error;
  resumeError?: Error;
  resumeGate?: Promise<void>;
  onResume?: () => void;
  closeCalls = 0;
  maintenancePauseOwner: string | null = null;
  private readonly jobs = new Map<string, FakeJob[]>();
  constructor(
    readonly semanticName: string,
    readonly parse: TargetQueueBoundary["parse"],
    paused = false,
  ) {
    this.paused = paused;
  }
  add(state: string, data: unknown) {
    const job = new FakeJob(data, this);
    this.jobs.set(state, [...(this.jobs.get(state) ?? []), job]);
    return job;
  }
  move(job: FakeJob, state: string) {
    this.remove(job);
    this.jobs.set(state, [...(this.jobs.get(state) ?? []), job]);
  }
  remove(job: FakeJob) {
    for (const [state, jobs] of this.jobs)
      this.jobs.set(
        state,
        jobs.filter((candidate) => candidate !== job),
      );
  }
  remainingRunIds() {
    return [...this.jobs.values()].flat().map((job) => (job.data as { runId?: string }).runId);
  }
  async isPaused() {
    return this.paused;
  }
  async pause() {
    this.pauseCalls += 1;
    this.paused = true;
    if (this.pauseError) throw this.pauseError;
  }
  async resume() {
    this.resumeCalls += 1;
    this.onResume?.();
    await this.resumeGate;
    if (this.resumeError) throw this.resumeError;
    this.paused = false;
  }
  async drain() {
    this.jobs.clear();
  }
  async clean() {
    return [];
  }
  async getJobs(states: string[]) {
    return states.flatMap((state) => this.jobs.get(state) ?? []);
  }
  async readMaintenancePauseOwner() {
    return this.maintenancePauseOwner;
  }
  async claimMaintenancePauseOwnership(runId: string) {
    if (this.maintenancePauseOwner === null) {
      this.maintenancePauseOwner = runId;
      return { outcome: "claimed" as const };
    }
    if (this.maintenancePauseOwner === runId) {
      return { outcome: "already_owned" as const };
    }
    return { outcome: "foreign_owner" as const, runId: this.maintenancePauseOwner };
  }
  async clearMaintenancePauseOwnership(runId: string) {
    if (this.maintenancePauseOwner !== runId) return false;
    this.maintenancePauseOwner = null;
    return true;
  }
  async close() {
    this.closeCalls += 1;
  }
}
