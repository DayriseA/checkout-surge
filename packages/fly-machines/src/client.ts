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

/** A volume mounted into a Machine. Fly reports the volume's name and size with it. */
export interface FlyMachineMount {
  volume: string;
  path: string;
  name?: string;
  size_gb?: number;
  [key: string]: unknown;
}

/** The full Machine config. Updates replace it entirely, so callers send a freshly read one. */
export interface FlyMachineConfig {
  guest: FlyMachineGuest;
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  mounts?: FlyMachineMount[];
  [key: string]: unknown;
}

export interface FlyVolume {
  id: string;
  name: string;
  region: string;
  /** `pending_destroy` once a deletion is accepted: Fly finishes it, even after a host outage. */
  state: string;
  attached_machine_id: string | null;
  /** ISO 8601 creation time. */
  created_at: string;
}

/** One entry of a Machine's event log, newest first. Fly omits a zero `exit_code`. */
export interface FlyMachineEvent {
  type: string;
  status?: string;
  /** Milliseconds since the epoch. */
  timestamp?: number;
  request?: { exit_event?: { exit_code?: number; requested_stop?: boolean } };
}

/** One container of a multi-container Machine, with its event log, newest first. */
export interface FlyMachineContainer {
  name: string;
  state: string;
  events?: { type: string; exit_code?: number; timestamp: number }[];
}

export interface FlyMachine {
  id: string;
  state: string;
  region: string;
  instance_id: string;
  /** The Machine's 6PN (private IPv6) address. */
  private_ip: string;
  /**
   * On a host whose `host_status` is not `ok`, Fly returns only a partial config, which may lack
   * any key (fly-go `GetConfig`); never copy it into a new Machine.
   */
  config: FlyMachineConfig;
  /** ISO 8601 creation time. */
  created_at: string;
  host_status?: string;
  events?: FlyMachineEvent[];
  containers?: FlyMachineContainer[];
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

/** A Machine as Fly reports it: `config` is unset on a host that is not ok. */
type ReportedMachine = Omit<FlyMachine, "config"> & {
  config?: FlyMachineConfig;
  incomplete_config?: FlyMachineConfig;
};

/** Like fly-go's `GetConfig`: the full config, else the partial one, else an empty one. */
function withConfig({ incomplete_config, ...machine }: ReportedMachine): FlyMachine {
  return { ...machine, config: machine.config ?? incomplete_config ?? ({} as FlyMachineConfig) };
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

  async listMachines(): Promise<FlyMachine[]> {
    return (await this.request<ReportedMachine[]>("GET", "/machines")).map(withConfig);
  }

  async getMachine(machineId: string): Promise<FlyMachine> {
    return withConfig(await this.request<ReportedMachine>("GET", `/machines/${machineId}`));
  }

  /**
   * Creates and launches a Machine. `region` may be a prioritized list such as `cdg,eu`, which Fly
   * tries in order.
   */
  createMachine(config: FlyMachineConfig, region: string): Promise<FlyMachine> {
    return this.request("POST", "/machines", { body: { config, region } });
  }

  /**
   * Creates a volume. `compute` is the size of the Machine that will mount it, so Fly places the
   * volume on a host that can run that Machine. `region` may be a prioritized list, like a Machine's.
   */
  createVolume(volume: {
    name: string;
    region: string;
    size_gb: number;
    compute: FlyMachineGuest;
  }): Promise<FlyVolume> {
    return this.request("POST", "/volumes", { body: volume });
  }

  listVolumes(): Promise<FlyVolume[]> {
    return this.request("GET", "/volumes");
  }

  async deleteVolume(volumeId: string): Promise<void> {
    await this.request("DELETE", `/volumes/${volumeId}`);
  }

  /** Destroys a Machine, even a running one or one on a dead host. Pass the nonce of a held lease. */
  async destroyMachine(machineId: string, nonce?: string): Promise<void> {
    await this.request("DELETE", `/machines/${machineId}?force=true`, nonce ? { nonce } : {});
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

  /** Pass the nonce of a held lease: without it, a stop blocks until the lease expires. */
  async stopMachine(machineId: string, nonce?: string): Promise<void> {
    await this.request("POST", `/machines/${machineId}/stop`, nonce ? { nonce } : {});
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

  /** Extends a held lease to `ttlSeconds` from now. */
  async refreshLease(machineId: string, nonce: string, ttlSeconds: number): Promise<void> {
    await this.request("POST", `/machines/${machineId}/lease`, {
      body: { ttl: ttlSeconds },
      nonce,
    });
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
