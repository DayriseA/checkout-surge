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
const secondRunId = "55555555-5555-4555-8555-555555555553";
const otherRunId = "55555555-5555-4555-8555-555555555555";
const connection = { url: process.env.TEST_REDIS_URL ?? "redis://localhost:6380" };
const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

describe("BullMQ exact-run maintenance", () => {
  it("pauses both physical queues and removes only selected run jobs", async () => {
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
    await orders.add(orderProcessJobName, orderJob(undefined));
    await notifications.add(notificationRecordJobName, notificationJob(runId), { delay: 60_000 });
    await notifications.add(notificationRecordJobName, notificationJob(otherRunId));

    await expect(maintenance.cleanRuns([runId])).resolves.toEqual({
      cleanedQueueCount: 2,
      cleanedJobCount: 2,
    });
    expect((await orders.getJobs(["waiting", "delayed"])).map((job) => job.data.runId)).toEqual(
      expect.arrayContaining([otherRunId, undefined]),
    );
    expect(
      (await notifications.getJobs(["waiting", "delayed"])).map((job) => job.data.runId),
    ).toEqual([otherRunId]);
    expect(await orders.isPaused()).toBe(false);
    expect(await notifications.isPaused()).toBe(false);
  });

  it("rejects an active selected job without deleting other selected jobs", async () => {
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
    await orders.add(orderProcessJobName, orderJob(secondRunId));
    for (let index = 0; index < 50 && (await orders.getActiveCount()) === 0; index += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(maintenance.cleanRuns([runId, secondRunId])).rejects.toMatchObject({
      code: "active_job",
    });
    expect(await orders.getWaitingCount()).toBe(1);
    expect(await orders.isPaused()).toBe(false);
    release();
  });

  it("removes every supported state for multiple runs and preserves other/catalog jobs", async () => {
    const states = ["waiting", "delayed", "prioritized", "paused", "failed", "completed"];
    const orders = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    const notifications = new FakeQueue("notifications:record", (data) =>
      notificationRecordJobSchema.parse(data),
    );
    for (const state of states) {
      orders.add(state, orderJob(runId));
      notifications.add(state, notificationJob(secondRunId));
    }
    orders.add("waiting", orderJob(otherRunId));
    notifications.add("completed", notificationJob(undefined));
    const maintenance = createDemoQueueMaintenance([orders, notifications]);

    await expect(maintenance.cleanRuns([runId, secondRunId])).resolves.toEqual({
      cleanedQueueCount: 2,
      cleanedJobCount: 12,
    });
    expect(orders.remainingRunIds()).toEqual([otherRunId]);
    expect(notifications.remainingRunIds()).toEqual([undefined]);
    expect(orders.pauseCalls).toBe(1);
    expect(notifications.pauseCalls).toBe(1);
    expect(orders.resumeCalls).toBe(1);
    expect(notifications.resumeCalls).toBe(1);
  });

  it("fails closed on a malformed selected job before removing valid selected jobs", async () => {
    const orders = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    const valid = orders.add("waiting", orderJob(runId));
    const malformed = orders.add("waiting", { runId });
    const maintenance = createDemoQueueMaintenance([orders]);

    await expect(maintenance.cleanRuns([runId])).rejects.toMatchObject({
      code: "malformed_claimed_job",
    });
    expect(valid.removed).toBe(false);
    expect(malformed.removed).toBe(false);
    expect(orders.paused).toBe(false);
  });

  it("preserves a genuinely pre-paused queue", async () => {
    const prePaused = new FakeQueue(
      "orders:process",
      (data) => orderProcessJobSchema.parse(data),
      true,
    );
    const changed = new FakeQueue("notifications:record", (data) =>
      notificationRecordJobSchema.parse(data),
    );
    const maintenance = createDemoQueueMaintenance([prePaused, changed]);

    await maintenance.cleanRuns([runId]);
    expect(prePaused.paused).toBe(true);
    expect(prePaused.pauseCalls).toBe(0);
    expect(prePaused.resumeCalls).toBe(0);
    expect(changed.paused).toBe(false);
    expect(changed.resumeCalls).toBe(1);
  });

  it("attempts every introduced resume after pause, clean, and resume failures", async () => {
    const first = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    const second = new FakeQueue("notifications:record", (data) =>
      notificationRecordJobSchema.parse(data),
    );
    second.pauseError = new Error("pause failed");
    await expect(createDemoQueueMaintenance([first, second]).cleanRuns([runId])).rejects.toThrow(
      "pause failed",
    );
    expect(first.resumeCalls).toBe(1);
    expect(second.resumeCalls).toBe(1);

    delete second.pauseError;
    first.add("waiting", orderJob(runId)).removeError = new Error("remove failed");
    await expect(createDemoQueueMaintenance([first, second]).cleanRuns([runId])).rejects.toThrow(
      "remove failed",
    );
    expect(first.resumeCalls).toBe(2);
    expect(second.resumeCalls).toBe(2);

    first.resumeError = new Error("resume first");
    second.resumeError = new Error("resume second");
    await expect(
      createDemoQueueMaintenance([first, second]).cleanRuns([runId]),
    ).rejects.toMatchObject({
      errors: expect.arrayContaining([first.resumeError, second.resumeError]),
    });
    expect(first.resumeCalls).toBe(4);
    expect(second.resumeCalls).toBe(4);
  });

  it("restores a transient resume failure before surfacing it, making an exact retry safe", async () => {
    const queue = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    queue.add("waiting", orderJob(runId));
    queue.resumeFailuresRemaining = 1;
    const maintenance = createDemoQueueMaintenance([queue]);

    await expect(maintenance.cleanRuns([runId])).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "transient resume failure" })],
    });
    expect(queue.paused).toBe(false);
    expect(queue.resumeCalls).toBe(2);
    await expect(maintenance.cleanRuns([runId])).resolves.toEqual({
      cleanedQueueCount: 1,
      cleanedJobCount: 0,
    });
    expect(queue.paused).toBe(false);
  });

  it("retains a persistently failed restoration until an exact retry can restore it", async () => {
    const queue = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    queue.add("waiting", orderJob(runId));
    queue.resumeError = new Error("persistent resume failure");
    const maintenance = createDemoQueueMaintenance([queue]);

    await expect(maintenance.cleanRuns([runId])).rejects.toMatchObject({
      errors: expect.arrayContaining([queue.resumeError]),
    });
    expect(queue.paused).toBe(true);
    expect(queue.resumeCalls).toBe(2);

    delete queue.resumeError;
    await expect(maintenance.cleanRuns([runId])).resolves.toEqual({
      cleanedQueueCount: 1,
      cleanedJobCount: 0,
    });
    expect(queue.paused).toBe(false);
    expect(queue.pauseCalls).toBe(1);
    expect(queue.resumeCalls).toBe(3);
  });

  it("returns a zero summary without pausing when no run is selected", async () => {
    const queue = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    await expect(createDemoQueueMaintenance([queue]).cleanRuns([])).resolves.toEqual({
      cleanedQueueCount: 0,
      cleanedJobCount: 0,
    });
    expect(queue.pauseCalls).toBe(0);
  });

  it("closes every queue and reports aggregate resource cleanup failures", async () => {
    const first = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    const second = new FakeQueue("notifications:record", (data) =>
      notificationRecordJobSchema.parse(data),
    );
    first.closeError = new Error("close first");
    second.closeError = new Error("close second");
    const maintenance = createDemoQueueMaintenance([first, second]);

    await expect(maintenance.close()).rejects.toMatchObject({
      errors: expect.arrayContaining([first.closeError, second.closeError]),
    });
    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(1);
    await expect(maintenance.cleanRuns([runId])).rejects.toThrow("closing");
  });

  it("retries outstanding restoration during close and aggregates restoration and close failures", async () => {
    const queue = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    queue.resumeError = new Error("persistent resume failure");
    queue.closeError = new Error("close failure");
    const maintenance = createDemoQueueMaintenance([queue]);

    await expect(maintenance.cleanRuns([runId])).rejects.toMatchObject({
      errors: expect.arrayContaining([queue.resumeError]),
    });
    await expect(maintenance.close()).rejects.toMatchObject({
      errors: expect.arrayContaining([queue.resumeError, queue.closeError]),
    });
    expect(queue.resumeCalls).toBe(4);
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
    ...(attributedRunId ? { runId: attributedRunId } : {}),
    quantity: 1,
    queuedAt: new Date().toISOString(),
  };
}

function notificationJob(attributedRunId?: string) {
  return {
    orderId: crypto.randomUUID(),
    saleOfferId: crypto.randomUUID(),
    correlationId: "corr-queue",
    ...(attributedRunId ? { runId: attributedRunId } : {}),
    recipientPlaceholder: "buyer@example.invalid",
    confirmedAt: new Date().toISOString(),
  };
}

class FakeJob implements TargetQueueJob {
  readonly id = crypto.randomUUID();
  readonly name = "fake";
  removed = false;
  removeError?: Error;
  constructor(
    readonly data: unknown,
    private readonly owner: FakeQueue,
  ) {}
  async remove() {
    if (this.removeError) throw this.removeError;
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
  resumeFailuresRemaining = 0;
  closeError?: Error;
  closeCalls = 0;
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
    if (this.resumeFailuresRemaining > 0) {
      this.resumeFailuresRemaining -= 1;
      throw new Error("transient resume failure");
    }
    if (this.resumeError) throw this.resumeError;
    this.paused = false;
  }
  async getJobs(states: string[]) {
    return states.flatMap((state) => this.jobs.get(state) ?? []);
  }
  async close() {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
  }
}
