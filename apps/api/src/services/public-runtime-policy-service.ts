import {
  type AdminPublicRuntimePolicyResponse,
  type AdminPublicRuntimePolicyUpdateRequest,
  adminPublicRuntimePolicyResponseSchema,
  type DeploymentHardCaps,
  type PublicRuntimePolicy,
  type PublicRuntimePolicyResponse,
  publicRuntimePolicyMutableSchema,
  publicRuntimePolicyResponseSchema,
  publicRuntimePolicySchema,
} from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, publicRuntimePolicies } from "@checkout-surge/db";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { DemoRunValidationError } from "./demo-run-validation-error.js";

export interface PublicRuntimePolicyController {
  getPublicRuntimePolicy(): Promise<PublicRuntimePolicyResponse>;
  getAdminPublicRuntimePolicy(correlationId: string): Promise<AdminPublicRuntimePolicyResponse>;
  updateAdminPublicRuntimePolicy(
    request: AdminPublicRuntimePolicyUpdateRequest,
    correlationId: string,
  ): Promise<AdminPublicRuntimePolicyResponse>;
}

export interface EffectivePublicRuntimePolicyReader {
  readEffectivePolicy(): Promise<PublicRuntimePolicy>;
}

type EffectivePolicyRow = Omit<typeof publicRuntimePolicies.$inferSelect, "policy"> & {
  policy: PublicRuntimePolicy;
};

export class PublicRuntimePolicyService
  implements PublicRuntimePolicyController, EffectivePublicRuntimePolicyReader
{
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      deploymentHardCaps: DeploymentHardCaps;
      now?: () => Date;
    },
  ) {}

  async getPublicRuntimePolicy(): Promise<PublicRuntimePolicyResponse> {
    const row = await this.readEffectivePolicyRow();
    return publicRuntimePolicyResponseSchema.parse({
      id: row.id,
      policy: row.policy,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  async getAdminPublicRuntimePolicy(
    correlationId: string,
  ): Promise<AdminPublicRuntimePolicyResponse> {
    return toAdminPublicRuntimePolicyResponse(
      await this.readEffectivePolicyRow(),
      correlationId,
      this.now(),
    );
  }

  async updateAdminPublicRuntimePolicy(
    request: AdminPublicRuntimePolicyUpdateRequest,
    correlationId: string,
  ): Promise<AdminPublicRuntimePolicyResponse> {
    const now = this.now();
    const mutablePolicy = publicRuntimePolicyMutableSchema.parse(request.policy);
    let effectivePolicy: PublicRuntimePolicy;
    try {
      effectivePolicy = resolveEffectivePublicRuntimePolicy(
        mutablePolicy,
        this.options.deploymentHardCaps,
      );
    } catch (error) {
      throwPublicRuntimePolicyUpdateError(error);
    }

    const [updated] = await this.options.db
      .update(publicRuntimePolicies)
      .set({ policy: mutablePolicy, updatedAt: now })
      .where(eq(publicRuntimePolicies.id, "active"))
      .returning();

    if (!updated) {
      throw new DemoRunValidationError(
        "resource_not_found",
        "Public runtime policy is not configured.",
      );
    }

    return toAdminPublicRuntimePolicyResponse(
      { ...updated, policy: effectivePolicy },
      correlationId,
      now,
    );
  }

  async readEffectivePolicy(): Promise<PublicRuntimePolicy> {
    return (await this.readEffectivePolicyRow()).policy;
  }

  async validateActivePolicyAtStartup(): Promise<void> {
    try {
      await this.readEffectivePolicyRow();
    } catch (error) {
      if (error instanceof DemoRunValidationError && error.code === "resource_not_found") {
        throw new Error('Active public runtime policy "active" is missing.');
      }
      if (!(error instanceof ZodError)) throw error;
      const diagnostics = error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "policy";
        const params = "params" in issue ? issue.params : undefined;
        const violationCode =
          params &&
          typeof params === "object" &&
          "violationCode" in params &&
          typeof params.violationCode === "string"
            ? ` (${params.violationCode})`
            : "";
        return `${path}${violationCode}: ${issue.message}`;
      });
      throw new Error(`Active public runtime policy is invalid: ${diagnostics.join("; ")}`);
    }
  }

  private async readEffectivePolicyRow(): Promise<EffectivePolicyRow> {
    const [row] = await this.options.db
      .select()
      .from(publicRuntimePolicies)
      .where(eq(publicRuntimePolicies.id, "active"))
      .limit(1);

    if (!row) {
      throw new DemoRunValidationError(
        "resource_not_found",
        "Public runtime policy is not configured.",
      );
    }

    return {
      ...row,
      policy: resolveEffectivePublicRuntimePolicy(row.policy, this.options.deploymentHardCaps),
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export function resolveEffectivePublicRuntimePolicy(
  persistedMutablePolicy: unknown,
  deploymentHardCaps: DeploymentHardCaps,
): PublicRuntimePolicy {
  const mutablePolicy = publicRuntimePolicyMutableSchema.parse(persistedMutablePolicy);
  return publicRuntimePolicySchema.parse({ ...mutablePolicy, deploymentHardCaps });
}

function throwPublicRuntimePolicyUpdateError(error: unknown): never {
  if (!(error instanceof ZodError)) throw error;
  const issue = error.issues[0];
  const params = issue && "params" in issue ? issue.params : undefined;
  if (
    issue &&
    params &&
    typeof params === "object" &&
    "violationCode" in params &&
    typeof params.violationCode === "string"
  ) {
    const details =
      "details" in params &&
      params.details &&
      typeof params.details === "object" &&
      !Array.isArray(params.details)
        ? (params.details as Record<string, unknown>)
        : undefined;
    throw new DemoRunValidationError("invalid_runtime_policy", issue.message, {
      violationCode: params.violationCode,
      path: issue.path,
      ...details,
    });
  }
  throw error;
}

function toAdminPublicRuntimePolicyResponse(
  row: EffectivePolicyRow,
  correlationId: string,
  timestamp: Date,
): AdminPublicRuntimePolicyResponse {
  return adminPublicRuntimePolicyResponseSchema.parse({
    id: row.id,
    policy: row.policy,
    updatedAt: row.updatedAt.toISOString(),
    correlationId,
    timestamp: timestamp.toISOString(),
  });
}
