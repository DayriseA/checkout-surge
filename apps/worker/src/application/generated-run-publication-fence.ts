export interface GeneratedRunPublicationFence {
  publish<T>(input: {
    runId: string;
    saleOfferId: string;
    operation: () => Promise<T>;
  }): Promise<T>;
}

export class GeneratedRunPublicationTimeoutError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`Generated-run publication did not settle within ${deadlineMs} ms.`);
    this.name = "GeneratedRunPublicationTimeoutError";
  }
}

/**
 * Fails a publication that has not settled by the deadline, as any other publication
 * failure. The fenced publication itself is not cancelled: it may still complete, and
 * its deterministic job ID keeps a later republication from duplicating it.
 */
export function withPublicationDeadline(
  fence: GeneratedRunPublicationFence,
  deadlineMs: number,
): GeneratedRunPublicationFence {
  return {
    publish(input) {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new GeneratedRunPublicationTimeoutError(deadlineMs)),
          deadlineMs,
        );
      });
      return Promise.race([fence.publish(input), deadline]).finally(() => clearTimeout(timer));
    },
  };
}
