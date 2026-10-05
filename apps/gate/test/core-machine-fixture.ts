import type { FlyMachine } from "@checkout-surge/fly-machines";

export function coreMachine(overrides: Partial<FlyMachine> = {}): FlyMachine {
  return {
    id: "core-1",
    state: "stopped",
    region: "cdg",
    instance_id: "v1",
    private_ip: "fdaa::5",
    created_at: "2026-10-03T10:00:00Z",
    config: {
      guest: { cpu_kind: "performance", cpus: 4, memory_mb: 8192 },
      metadata: { role: "core" },
    },
    ...overrides,
  };
}
