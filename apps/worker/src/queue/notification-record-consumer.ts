export interface NotificationRecordConsumer {
  start(): void;
  close(): Promise<void>;
  isRunning(): boolean;
  checkConnectivity(): Promise<void>;
}
