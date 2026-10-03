/**
 * A thin client for the Fly Machines API of one app. It maps calls to HTTP and holds no business
 * rule: callers decide what to do with each state and error.
 */

export interface FlyMachineGuest {
  cpu_kind: string;
  cpus: number;
  memory_mb: number;
  [key: string]: unknown;
}

/** The full Machine config. Updates replace it entirely, so callers send a freshly read one. */
export interface FlyMachineConfig {
  guest: FlyMachineGuest;
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  [key: string]: unknown;
}

export interface FlyMachine {
  id: string;
  state: string;
  region: string;
  instance_id: string;
  config: FlyMachineConfig;
}

export class FlyMachinesApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Fly Machines API ${method} ${path} failed with ${status}: ${body}`);
    this.name = "FlyMachinesApiError";
  }
}

const defaultBaseUrl = "https://api.machines.dev";
const defaultRequestTimeoutMs = 30_000;
const leaseNonceHeaderName = "fly-machine-lease-nonce";

export class FlyMachinesClient {
  constructor(
    private readonly options: {
      appName: string;
      token: string;
      baseUrl?: string;
      requestTimeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {}

  listMachines(): Promise<FlyMachine[]> {
    return this.request("GET", "/machines");
  }

  getMachine(machineId: string): Promise<FlyMachine> {
    return this.request("GET", `/machines/${machineId}`);
  }

  /** Replaces the Machine config without starting the Machine. */
  updateMachine(machineId: string, config: FlyMachineConfig, nonce: string): Promise<FlyMachine> {
    return this.request("POST", `/machines/${machineId}`, {
      body: { config, skip_launch: true },
      nonce,
    });
  }

  async startMachine(machineId: string, nonce: string): Promise<void> {
    await this.request("POST", `/machines/${machineId}/start`, { nonce });
  }

  async stopMachine(machineId: string, nonce: string): Promise<void> {
    await this.request("POST", `/machines/${machineId}/stop`, { nonce });
  }

  /**
   * Waits until the Machine reaches `state`. Resolves `false` when Fly reports the timeout (408),
   * which it caps at 60 seconds.
   */
  async waitForState(
    machineId: string,
    state: "started" | "stopped",
    options: { timeoutSeconds: number; instanceId?: string },
  ): Promise<boolean> {
    const query = new URLSearchParams({ state, timeout: String(options.timeoutSeconds) });
    if (options.instanceId) query.set("instance_id", options.instanceId);
    try {
      await this.request("GET", `/machines/${machineId}/wait?${query}`, {
        timeoutMs: (options.timeoutSeconds + 10) * 1000,
      });
      return true;
    } catch (error) {
      if (error instanceof FlyMachinesApiError && error.status === 408) return false;
      throw error;
    }
  }

  /** Acquires the Machine lease and returns its nonce. A held lease answers 409. */
  async acquireLease(machineId: string, ttlSeconds: number, description: string): Promise<string> {
    const response = await this.request<{ data: { nonce: string } }>(
      "POST",
      `/machines/${machineId}/lease`,
      { body: { ttl: ttlSeconds, description } },
    );
    return response.data.nonce;
  }

  async releaseLease(machineId: string, nonce: string): Promise<void> {
    await this.request("DELETE", `/machines/${machineId}/lease`, { nonce });
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; nonce?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.baseUrl ?? defaultBaseUrl}/v1/apps/${this.options.appName}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
          ...(options.nonce ? { [leaseNonceHeaderName]: options.nonce } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(
          options.timeoutMs ?? this.options.requestTimeoutMs ?? defaultRequestTimeoutMs,
        ),
      },
    );
    const text = await response.text();
    if (!response.ok) throw new FlyMachinesApiError(method, path, response.status, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
