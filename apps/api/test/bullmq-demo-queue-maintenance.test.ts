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

  it("pauses and resumes both physical queues", async () => {
    const orders = new Queue(orderProcessBullMqQueueName, { connection });
    const notifications = new Queue(notificationRecordBullMqQueueName, { connection });
    await Promise.all([
      orders.obliterate({ force: true }),
      notifications.obliterate({ force: true }),
    ]);
    const maintenance = createBullMqDemoQueueMaintenance(connection);
    resources.push(maintenance, orders, notifications);

    const lease = await maintenance.acquireGeneratedRunQuiescence(runId);
    expect(await orders.isPaused()).toBe(true);
    expect(await notifications.isPaused()).toBe(true);

    await lease.release();
    expect(await orders.isPaused()).toBe(false);
    expect(await notifications.isPaused()).toBe(false);
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
    await lease?.release();
    expect(prePaused.paused).toBe(true);
    expect(prePaused.resumeCalls).toBe(0);
    expect(changed.paused).toBe(false);
  });

  it("reports resume failures after attempting every maintenance-owned queue", async () => {
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
    await expect(firstLease?.release()).rejects.toThrow("Could not fully restore");
    expect(owned.paused).toBe(true);
    expect(owned.resumeCalls).toBe(1);
    expect(prePaused.resumeCalls).toBe(0);

    delete owned.resumeError;
    const retryLease = await maintenance.acquireGeneratedRunQuiescence(runId);
    await retryLease.release();
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
    await retryLease?.release();
    expect(first.paused).toBe(false);
    expect(second.paused).toBe(false);

    const third = new FakeQueue("third", (data) => orderProcessJobSchema.parse(data));
    const fourth = new FakeQueue("fourth", (data) => orderProcessJobSchema.parse(data));
    const releaseMaintenance = createDemoQueueMaintenance([third, fourth]);
    const lease = await releaseMaintenance.acquireGeneratedRunQuiescence?.(runId);
    third.resumeError = new Error("resume third");
    fourth.resumeError = new Error("resume fourth");
    await expect(lease?.release()).rejects.toMatchObject({
      errors: expect.arrayContaining([third.resumeError, fourth.resumeError]),
    });
    expect(third.resumeCalls).toBe(1);
    expect(fourth.resumeCalls).toBe(1);
  });

  it("waits for an active lease before closing and rejects later acquisitions", async () => {
    const queue = new FakeQueue("orders:process", (data) => orderProcessJobSchema.parse(data));
    const maintenance = createDemoQueueMaintenance([queue]);
    const lease = await maintenance.acquireGeneratedRunQuiescence(runId);
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

    await lease.release();
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
  async close() {
    this.closeCalls += 1;
  }
}
