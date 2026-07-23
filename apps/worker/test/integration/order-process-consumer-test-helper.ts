import {
  type CreateBullMqOrderProcessConsumerOptions,
  createBullMqOrderProcessConsumer as createProductionBullMqOrderProcessConsumer,
} from "../../src/queue/bullmq-order-process-consumer.js";

export function createBullMqOrderProcessConsumer(
  options: Omit<CreateBullMqOrderProcessConsumerOptions, "recovery"> &
    Partial<Pick<CreateBullMqOrderProcessConsumerOptions, "recovery">>,
) {
  return createProductionBullMqOrderProcessConsumer({
    recovery: { recordRecoverable: async () => undefined, recordDeadLetter: async () => undefined },
    ...options,
  });
}
