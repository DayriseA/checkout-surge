import {
  type CreateBullMqOrderProcessConsumerOptions,
  createBullMqOrderProcessConsumer as createProductionBullMqOrderProcessConsumer,
} from "../../src/queue/bullmq-order-process-consumer.js";

export function createBullMqOrderProcessConsumer(
  options: Omit<CreateBullMqOrderProcessConsumerOptions, "recovery" | "closeDeadlineMs"> &
    Partial<Pick<CreateBullMqOrderProcessConsumerOptions, "recovery" | "closeDeadlineMs">>,
) {
  return createProductionBullMqOrderProcessConsumer({
    recovery: { recordRecoverable: async () => undefined, recordDeadLetter: async () => undefined },
    closeDeadlineMs: 5_000,
    ...options,
  });
}
