export interface OrderProcessConsumer {
  start(): void;
  close(): Promise<void>;
  isRunning(): boolean;
  checkConnectivity(): Promise<void>;
}
