export function terminalDemoRunTransitionLockKey(runId: string): string {
  return `demo_run_finalize:${runId}`;
}
