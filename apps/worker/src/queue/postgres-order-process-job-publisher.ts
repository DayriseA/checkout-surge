import type { OrderProcessJob } from "@checkout-surge/contracts";
import type { PostgresOrderDelivery, SqlClient } from "@checkout-surge/db";
import type { GeneratedRunPublicationFence } from "../application/generated-run-publication-fence.js";
import type { OrderJobPublisher } from "../application/order-job-publisher.js";
import type { OrderDeliveryStateReader } from "../application/order-recovery-scanner.js";

export function createPostgresOrderProcessJobPublisher(options: {
  sql: SqlClient;
  delivery: PostgresOrderDelivery;
  publicationFence: GeneratedRunPublicationFence;
}): OrderJobPublisher & OrderDeliveryStateReader {
  return {
    async enqueue(job: OrderProcessJob, publication = {}) {
      await options.publicationFence.publish({
        runId: job.runId,
        saleOfferId: job.saleOfferId,
        operation: async (session) => {
          const rows =
            await session`select id from demo_runs where id=${job.runId} and execution_mode='without_redis'`;
          if (rows.length !== 1)
            throw new Error(`Run ${job.runId} does not use PostgreSQL order delivery.`);
          await options.delivery.publish(session, job, publication);
        },
      });
    },
    async isDeliveryPending(publicationId) {
      const rows = await options.sql`select publication_id from postgres_order_deliveries
        where publication_id=${publicationId} and settled_at is null`;
      return rows.length === 1;
    },
  };
}
