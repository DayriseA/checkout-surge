import { z } from "zod";
import {
  acceptedErpChaosConfigSchema,
  erpChaosConfigSchema,
  largestAllowedErpLatencyMs,
} from "./erp.js";
import {
  isoTimestampSchema,
  nonnegativeIntegerSchema,
  nonnegativeNumberSchema,
  positiveIntegerSchema,
} from "./primitives.js";

/**
 * Predefined, versioned ERP condition profiles (D10). Profiles are admin
 * presets: no public profile editor and no public outage capability. A profile
 * is anchored at run acceptance time plus the configured start delay, both
 * taken from the durable accepted snapshot, so a mock ERP restart cannot
 * restart the timeline.
 */
export const erpProfileIdentitySchema = z
  .object({
    profileId: z.string().trim().min(1),
    version: positiveIntegerSchema,
  })
  .strict();
export type ErpProfileIdentity = z.infer<typeof erpProfileIdentitySchema>;

/**
 * One finite segment of changing conditions. `offsetSeconds` and
 * `durationSeconds` are measured from the profile anchor; an override field
 * that is absent keeps the base configuration value. After the last segment the
 * conditions recover to the base (`recoveryToBase`).
 */
export const erpProfileSegmentOverrideSchema = z
  .object({
    latencyMs: nonnegativeIntegerSchema.optional(),
    maxTps: positiveIntegerSchema.optional(),
    forcedOutage: z.boolean().optional(),
  })
  .strict();
export type ErpProfileSegmentOverride = z.infer<typeof erpProfileSegmentOverrideSchema>;

export const erpProfileSegmentSchema = z
  .object({
    offsetSeconds: nonnegativeNumberSchema,
    durationSeconds: positiveIntegerSchema,
    override: erpProfileSegmentOverrideSchema,
  })
  .strict();
export type ErpProfileSegment = z.infer<typeof erpProfileSegmentSchema>;

export const erpProfileSchema = z
  .object({
    identity: erpProfileIdentitySchema,
    baseConfig: erpChaosConfigSchema,
    segments: z.array(erpProfileSegmentSchema).min(1),
    recoveryToBase: z.literal(true),
  })
  .strict()
  .superRefine((profile, context) => {
    let previousOffset: number | null = null;
    for (const segment of profile.segments) {
      if (previousOffset !== null && segment.offsetSeconds <= previousOffset) {
        context.addIssue({
          code: "custom",
          path: ["segments"],
          message: "Profile segments must have strictly increasing offsets from the anchor.",
        });
        break;
      }
      previousOffset = segment.offsetSeconds;
    }
  });
export type ErpProfile = z.infer<typeof erpProfileSchema>;

/** Write/acceptance boundary. Keep erpProfileSchema permissive for historical profiles. */
export const acceptedErpProfileSchema = erpProfileSchema.safeExtend({
  baseConfig: acceptedErpChaosConfigSchema,
  segments: z
    .array(
      erpProfileSegmentSchema.safeExtend({
        override: erpProfileSegmentOverrideSchema.safeExtend({
          latencyMs: nonnegativeIntegerSchema.max(largestAllowedErpLatencyMs).optional(),
        }),
      }),
    )
    .min(1),
});

/**
 * Durable profile anchor (D10): run acceptance time plus the configured start
 * delay, both from the accepted snapshot.
 */
export const erpProfileAnchorSchema = z
  .object({
    acceptedAt: isoTimestampSchema,
    startDelaySeconds: nonnegativeIntegerSchema,
  })
  .strict();
export type ErpProfileAnchor = z.infer<typeof erpProfileAnchorSchema>;
