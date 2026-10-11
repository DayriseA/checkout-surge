import { type InventoryStatus, inventoryStatusSchema } from "@checkout-surge/contracts";
import { sql } from "drizzle-orm";
import type { CheckoutSurgeDatabase } from "./client.js";
import {
  InventoryNotInitializedError,
  reservationThroughputWindowSeconds,
} from "./redis-inventory.js";

interface InventoryRead extends Record<string, unknown> {
  allocated_stock: number;
  remaining_stock: number;
  reserved_stock: number;
  pending_count: number;
  expired_count: number;
  oldest_pending_age: number;
  secured_count: number;
  peak_rate: number;
  rejection_count: number | null;
  latest_observed_at: Date | string | null;
  last_updated_at: Date | string;
}

/** Reads PostgreSQL-owned inventory and its observations in one statement snapshot. */
export async function getPostgresInventoryStatus(
  db: Pick<CheckoutSurgeDatabase, "execute">,
  saleOfferId: string,
  now = new Date(),
): Promise<InventoryStatus> {
  const observedAt = now.toISOString();
  const currentSecond = Math.floor(now.getTime() / 1000);
  const firstIncludedSecond = currentSecond - reservationThroughputWindowSeconds + 1;
  const [row] = await db.execute<InventoryRead>(sql`with held as (
      select h.hold,h.pending_record,h.reversed_at,
        (h.hold->>'securedAt')::timestamptz as secured_at
      from postgres_reservation_holds h join postgres_run_inventory i
        on i.run_id=h.run_id and i.sale_offer_id=h.sale_offer_id
      where i.sale_offer_id=${saleOfferId}
    ), pending as (
      select count(*)::int as count,min(secured_at) as oldest
      from held where reversed_at is null and pending_record is not null
    ), throughput as (
      select floor(extract(epoch from secured_at)) as second,count(*)::int as count
      from held where floor(extract(epoch from secured_at)) between ${firstIncludedSecond} and ${currentSecond}
      group by second
    ) select i.allocated_stock,i.remaining_stock,i.reserved_stock,
      p.count as pending_count,
      (select count(*)::int from held where reversed_at is null
        and (hold->>'expiresAt')::timestamptz<=${observedAt}::timestamptz) as expired_count,
      coalesce(greatest(0,extract(epoch from (${observedAt}::timestamptz-p.oldest))),0)::double precision as oldest_pending_age,
      (select coalesce(sum(count),0)::int from throughput) as secured_count,
      (select coalesce(max(count),0)::int from throughput) as peak_rate,
      c.count as rejection_count,c.latest_observed_at,
      greatest(i.updated_at,c.latest_observed_at) as last_updated_at
    from postgres_run_inventory i cross join pending p
    left join postgres_run_sold_out_counts c on c.run_id=i.run_id
    where i.sale_offer_id=${saleOfferId}`);
  if (!row) throw new InventoryNotInitializedError(saleOfferId);
  if (row.remaining_stock + row.reserved_stock !== row.allocated_stock) {
    throw new Error("Inventory stock counters must sum to allocatedStock.");
  }
  return inventoryStatusSchema.parse({
    saleOfferId,
    allocatedStock: row.allocated_stock,
    remainingStock: row.remaining_stock,
    reservedStock: row.reserved_stock,
    pendingPersistenceCount: row.pending_count,
    expiredReservationCount: row.expired_count,
    oldestPendingPersistenceAgeSeconds: row.oldest_pending_age,
    reservationThroughput: {
      windowSeconds: reservationThroughputWindowSeconds,
      successfulReservationCount: row.secured_count,
      peakRatePerSecond: row.peak_rate,
      peakWindowSeconds: 1,
      unit: "reservations_per_second",
      measuredAt: observedAt,
    },
    soldOutPressure: {
      rejectionCount: row.rejection_count,
      latestObservedAt: row.latest_observed_at
        ? new Date(row.latest_observed_at).toISOString()
        : null,
    },
    observedAt,
    lastUpdatedAt: new Date(row.last_updated_at).toISOString(),
  });
}
