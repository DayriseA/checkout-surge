/**
 * Zod schemas for everything under results/data/.
 *
 * Shared between the app (src/lib/data.ts) and the standalone checker
 * (scripts/check-data.ts), so keep this file free of Vite-specific imports.
 */
import { z } from "zod";

export const severitySchema = z.enum(["high", "medium", "low", "info"]);
export type Severity = z.infer<typeof severitySchema>;

export const SEVERITY_ORDER: Severity[] = ["high", "medium", "low", "info"];

export const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  vendor: z.string().min(1),
  effort: z.string().min(1),
  reportFile: z.string().min(1),
  notes: z.string().optional(),
});
export type Model = z.infer<typeof modelSchema>;

export const modelsFileSchema = z.object({ models: z.array(modelSchema).min(1) });

export const sliceSchema = z.object({
  id: z.number().int().min(1),
  name: z.string().min(1),
  focus: z.string().min(1),
});
export type Slice = z.infer<typeof sliceSchema>;

export const slicesFileSchema = z.object({ slices: z.array(sliceSchema).min(1) });

export const findingSchema = z.object({
  id: z.string().regex(/^[a-z0-9.-]+:[FN]\d+$/, "expected '<model>:<code>'"),
  code: z.string().regex(/^[FN]\d+$/, "expected F{n} or N{n}"),
  title: z.string().min(1),
  severity: severitySchema,
  tier: z.enum(["finding", "note"]),
  slices: z.array(z.number().int().min(1).max(8)).min(1),
  locations: z.array(z.string().min(1)),
  summary: z.string().min(1),
});
export type Finding = z.infer<typeof findingSchema>;

export const findingsFileSchema = z.object({
  model: z.string().min(1),
  reviewType: z.literal("auto-review"),
  source: z.string().min(1),
  findings: z.array(findingSchema).min(1),
});
export type FindingsFile = z.infer<typeof findingsFileSchema>;

export const clusterSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  members: z
    .array(z.object({ findingId: z.string().min(1), note: z.string().optional() }))
    .min(1),
  notObserved: z
    .array(z.object({ model: z.string().min(1), note: z.string().min(1) }))
    .optional(),
});
export type Cluster = z.infer<typeof clusterSchema>;

export const clustersFileSchema = z.object({ clusters: z.array(clusterSchema) });

export const manualFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: severitySchema,
  slices: z.array(z.number().int().min(1).max(8)).optional(),
  status: z.enum(["open", "confirmed", "fixed", "wont-fix"]),
  caughtInSelfAudit: z.boolean(),
  relatedFindingIds: z.array(z.string()).default([]),
  description: z.string().min(1),
});
export type ManualFinding = z.infer<typeof manualFindingSchema>;

export const manualFindingsFileSchema = z.object({
  model: z.string().min(1),
  reviewType: z.literal("manual"),
  findings: z.array(manualFindingSchema),
});
export type ManualFindingsFile = z.infer<typeof manualFindingsFileSchema>;

export const verdictSchema = z.enum(["better", "same", "worse", "missing", "unknown"]);
export type Verdict = z.infer<typeof verdictSchema>;

export const comparisonSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  reference: z.string().min(1),
  verdicts: z.record(z.string(), verdictSchema),
  notes: z.string().min(1),
});
export type Comparison = z.infer<typeof comparisonSchema>;
