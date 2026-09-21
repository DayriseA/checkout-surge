export interface GeneratedRunPublicationFence {
  publish<T>(input: {
    runId: string;
    saleOfferId: string;
    operation: () => Promise<T>;
  }): Promise<T>;
}
