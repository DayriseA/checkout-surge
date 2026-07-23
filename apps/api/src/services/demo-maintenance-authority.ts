export interface DemoMaintenanceAuthority {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

/** Serializes maintenance workflows owned by the single API process. */
export class ProcessLocalDemoMaintenanceAuthority implements DemoMaintenanceAuthority {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
