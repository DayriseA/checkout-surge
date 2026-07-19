import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRuns,
  inventoryKeys,
  type PendingPersistenceRecord,
  pendingPersistenceIndexKey,
  readPendingPersistenceRecords,
} from "@checkout-surge/db";
import { eq } from "drizzle-orm";
import type { PendingPersistenceReconciler } from "./pending-persistence-reconciler.js";
import type { BuyPersistence } from "./reserve-order-service.js";
import { isPersistedBuyForReservation } from "./reserve-order-service.js";

export interface PendingPersistenceRemediationTarget {
  runId: string;
  saleOfferId: string;
}

export interface PendingPersistenceRemediationInspection {
  target: PendingPersistenceRemediationTarget;
  runStatus: string | null;
  pendingCount: number;
  recordCount: number;
  globalIndexCount: number;
  targetGlobalMemberCount: number;
  classifications: Array<{
    reservationId: string;
    disposition: "durable" | "reverse" | "unsafe";
    reason: string;
  }>;
  safeToApply: boolean;
}

export class PendingPersistenceRemediationService {
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      persistence: BuyPersistence;
      reconciler: Pick<PendingPersistenceReconciler, "reconcileSaleOffer">;
      maxRecordsPerTarget?: number;
      maxGlobalIndexRecords?: number;
      batchSize?: number;
    },
  ) {}

  async inspect(
    target: PendingPersistenceRemediationTarget,
  ): Promise<PendingPersistenceRemediationInspection> {
    const keys = inventoryKeys(target.saleOfferId);
    const maxRecords = this.options.maxRecordsPerTarget ?? 1_000;
    const maxGlobalRecords = this.options.maxGlobalIndexRecords ?? 10_000;
    const [[run], pendingCount, pendingRecordHashCount, globalIndexCount] = await Promise.all([
      this.options.db
        .select({ status: demoRuns.status, saleOfferId: demoRuns.saleOfferId })
        .from(demoRuns)
        .where(eq(demoRuns.id, target.runId))
        .limit(1),
      this.options.redis.zcard(keys.pendingPersistence),
      this.options.redis.hlen(keys.pendingPersistenceRecords),
      this.options.redis.zcard(pendingPersistenceIndexKey),
    ]);

    const boundedFailures: PendingPersistenceRemediationInspection["classifications"] = [];
    if (pendingCount > maxRecords) {
      boundedFailures.push({
        reservationId: "bounded-report",
        disposition: "unsafe",
        reason: `pending_count_exceeds_limit_${maxRecords}`,
      });
    }
    if (globalIndexCount > maxGlobalRecords) {
      boundedFailures.push({
        reservationId: "bounded-report",
        disposition: "unsafe",
        reason: `global_index_count_exceeds_limit_${maxGlobalRecords}`,
      });
    }
    if (boundedFailures.length > 0) {
      return this.unsafeInspection(
        target,
        run?.status ?? null,
        pendingCount,
        0,
        globalIndexCount,
        0,
        boundedFailures,
      );
    }

    const [records, globalMembers] = await Promise.all([
      readPendingPersistenceRecords(this.options.redis, {
        saleOfferId: target.saleOfferId,
        limit: maxRecords,
      }),
      globalIndexCount === 0
        ? Promise.resolve([])
        : this.options.redis.zrange(pendingPersistenceIndexKey, 0, globalIndexCount - 1),
    ]);
    const classifications: PendingPersistenceRemediationInspection["classifications"] = [];
    const terminal = run?.status === "completed" || run?.status === "failed";
    const runOwned = run?.saleOfferId === target.saleOfferId;
    const globalMemberPrefix = `${target.saleOfferId}:`;
    const targetGlobalMembers = globalMembers.filter((member) =>
      member.startsWith(globalMemberPrefix),
    );
    const expectedGlobalMembers = new Set(
      records.map((record) => `${target.saleOfferId}:${record.id}`),
    );

    for (const expectedMember of expectedGlobalMembers) {
      if (!targetGlobalMembers.includes(expectedMember)) {
        classifications.push({
          reservationId: expectedMember.slice(globalMemberPrefix.length),
          disposition: "unsafe",
          reason: "global_index_member_missing",
        });
      }
    }
    for (const member of targetGlobalMembers) {
      if (!expectedGlobalMembers.has(member)) {
        classifications.push({
          reservationId: member.slice(globalMemberPrefix.length) || "bounded-report",
          disposition: "unsafe",
          reason: "unexpected_global_index_member",
        });
      }
    }

    for (const record of records) {
      if (record.runId !== target.runId || record.saleOfferId !== target.saleOfferId) {
        classifications.push({
          reservationId: record.id,
          disposition: "unsafe",
          reason: "redis_record_run_or_sale_mismatch",
        });
        continue;
      }
      const reservation = {
        id: record.id,
        saleOfferId: record.saleOfferId,
        correlationId: record.correlationId,
        runId: record.runId,
        quantity: record.quantity,
        status: "secured" as const,
        reservationToken: record.reservationToken,
        securedAt: record.securedAt,
        expiresAt: record.expiresAt,
      };
      const durable = await this.options.persistence.getPersistedBuyByReservationId(record.id);
      let disposition: "durable" | "reverse" | "unsafe";
      let reason: string;
      if (durable) {
        disposition = isPersistedBuyForReservation(durable, reservation) ? "durable" : "unsafe";
        reason =
          disposition === "durable"
            ? "matching_reservation_and_order"
            : "durable_attribution_mismatch";
      } else {
        disposition = terminal && runOwned ? "reverse" : "unsafe";
        reason =
          disposition === "reverse"
            ? "terminal_run_without_durable_buy"
            : "run_not_terminal_or_sale_not_owned";
      }

      if (disposition !== "unsafe") {
        const idempotencyFailure = await this.inspectIdempotencyRecord(record, disposition);
        if (idempotencyFailure) {
          disposition = "unsafe";
          reason = idempotencyFailure;
        }
      }
      classifications.push({ reservationId: record.id, disposition, reason });
    }

    if (records.length !== pendingCount || pendingRecordHashCount !== pendingCount) {
      classifications.push({
        reservationId: "bounded-report",
        disposition: "unsafe",
        reason: "pending_record_or_hold_missing_or_malformed",
      });
    }
    const safeToApply =
      terminal &&
      runOwned &&
      records.length === pendingCount &&
      classifications.every((classification) => classification.disposition !== "unsafe");
    return {
      target,
      runStatus: run?.status ?? null,
      pendingCount,
      recordCount: records.length,
      globalIndexCount,
      targetGlobalMemberCount: targetGlobalMembers.length,
      classifications,
      safeToApply,
    };
  }

  async apply(target: PendingPersistenceRemediationTarget): Promise<{
    inspection: PendingPersistenceRemediationInspection;
    passes: number;
    finalPendingCount: number;
    finalRecordCount: number;
    remainingGlobalMembers: number;
  }> {
    const inspection = await this.inspect(target);
    if (!inspection.safeToApply) {
      throw new Error("Remediation inspection is unsafe; no mutation was attempted.");
    }

    const batchSize = this.options.batchSize ?? 100;
    const maxPasses = Math.ceil(inspection.pendingCount / batchSize) + 2;
    let passes = 0;
    while (passes < maxPasses) {
      const result = await this.options.reconciler.reconcileSaleOffer(target.saleOfferId, {
        runId: target.runId,
      });
      passes += 1;
      if (result.found === 0) break;
      if (result.failed > 0) {
        throw new Error(
          `Remediation pass ${passes} left ${result.failed} record(s) retryable; rerun dry-run before retrying apply.`,
        );
      }
    }

    const keys = inventoryKeys(target.saleOfferId);
    const [finalPendingCount, finalRecordCount, remainingTargetGlobalMembers] = await Promise.all([
      this.options.redis.zcard(keys.pendingPersistence),
      this.options.redis.hlen(keys.pendingPersistenceRecords),
      this.readTargetGlobalMembers(target.saleOfferId),
    ]);
    const remainingGlobalMembers = remainingTargetGlobalMembers.length;
    if (finalPendingCount !== 0 || finalRecordCount !== 0 || remainingGlobalMembers !== 0) {
      throw new Error("Remediation stopped before all three Redis pending structures converged.");
    }
    return {
      inspection,
      passes,
      finalPendingCount,
      finalRecordCount,
      remainingGlobalMembers,
    };
  }

  private unsafeInspection(
    target: PendingPersistenceRemediationTarget,
    runStatus: string | null,
    pendingCount: number,
    recordCount: number,
    globalIndexCount: number,
    targetGlobalMemberCount: number,
    classifications: PendingPersistenceRemediationInspection["classifications"],
  ): PendingPersistenceRemediationInspection {
    return {
      target,
      runStatus,
      pendingCount,
      recordCount,
      globalIndexCount,
      targetGlobalMemberCount,
      classifications,
      safeToApply: false,
    };
  }

  private async readTargetGlobalMembers(saleOfferId: string): Promise<string[]> {
    const globalIndexCount = await this.options.redis.zcard(pendingPersistenceIndexKey);
    const maxGlobalRecords = this.options.maxGlobalIndexRecords ?? 10_000;
    if (globalIndexCount > maxGlobalRecords) {
      throw new Error(
        `Global pending-persistence index exceeds verification limit ${maxGlobalRecords}.`,
      );
    }
    const members =
      globalIndexCount === 0
        ? []
        : await this.options.redis.zrange(pendingPersistenceIndexKey, 0, globalIndexCount - 1);
    const prefix = `${saleOfferId}:`;
    return members.filter((member) => member.startsWith(prefix));
  }

  private async inspectIdempotencyRecord(
    record: PendingPersistenceRecord,
    disposition: "durable" | "reverse",
  ): Promise<string | null> {
    const key = inventoryKeys(record.saleOfferId).idempotency(record.idempotencyKey);
    const raw = await this.options.redis.get(key);
    if (raw === null) {
      return null;
    }
    const ttl = await this.options.redis.pttl(key);
    if (ttl <= 0) {
      return "idempotency_record_without_positive_ttl";
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return "idempotency_record_malformed";
    }
    if (!isRecord(parsed) || !isRecord(parsed.reservation)) {
      return "idempotency_record_malformed";
    }
    const allowedStatus =
      parsed.status === "pending_persistence" ||
      (disposition === "durable" && parsed.status === "accepted");
    if (!allowedStatus) {
      return "idempotency_record_status_conflicts_with_disposition";
    }
    const reservation = parsed.reservation;
    if (
      parsed.quantity !== record.quantity ||
      reservation.id !== record.id ||
      reservation.saleOfferId !== record.saleOfferId ||
      reservation.quantity !== record.quantity ||
      reservation.status !== "secured" ||
      reservation.reservationToken !== record.reservationToken ||
      reservation.correlationId !== record.correlationId ||
      (reservation.runId ?? "") !== (record.runId ?? "") ||
      reservation.securedAt !== record.securedAt ||
      reservation.expiresAt !== record.expiresAt
    ) {
      return "idempotency_record_attribution_mismatch";
    }
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
