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

/**
 * Independent-review findings: the same fixed reviewer model reviews each
 * agent's post-fix implementation branch, following the same report format
 * as the self-audits (docs/review_helper.md). The `ir-` id namespace keeps
 * these globally distinct from the auto-review findings while the report
 * codes themselves stay plain F{n}/N{n}.
 */
export const independentFindingSchema = findingSchema.extend({
  id: z
    .string()
    .regex(/^[a-z0-9.-]+:ir-[FN]\d+$/, "expected '<model>:ir-<code>'"),
  // auto-review findings on the same branch that cover the same issue class;
  // empty means the self-audit did not identify this issue class
  relatedFindingIds: z.array(z.string()).default([]),
});
export type IndependentFinding = z.infer<typeof independentFindingSchema>;

export const independentFindingsFileSchema = z.object({
  model: z.string().min(1), // the agent/branch under review
  reviewType: z.literal("independent-review"),
  reviewer: z.string().min(1), // the fixed reviewer model
  source: z.string().min(1),
  findings: z.array(independentFindingSchema).min(1),
});
export type IndependentFindingsFile = z.infer<typeof independentFindingsFileSchema>;

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

export const postFixAssessmentSchema = z.enum([
  "self-audit-caught-but-reproduced",
  "self-audit-missed",
]);
export type PostFixAssessment = z.infer<typeof postFixAssessmentSchema>;

export const independentReviewRelationSchema = z.object({
  findingId: z
    .string()
    .regex(/^[a-z0-9.-]+:ir-[FN]\d+$/, "expected '<model>:ir-<code>'"),
  relationship: z.enum(["same-issue", "related-symptom"]),
  note: z.string().min(1),
});
export type IndependentReviewRelation = z.infer<typeof independentReviewRelationSchema>;

export const browserUseTestFindingSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9.-]+:E\d+$/, "expected '<model>:E{n}'"),
    title: z.string().min(1),
    severity: severitySchema,
    slices: z.array(z.number().int().min(1).max(8)).optional(),
    status: z.enum(["open", "confirmed", "fixed", "wont-fix"]),
    postFixAssessment: postFixAssessmentSchema,
    relatedFindingIds: z.array(z.string()).default([]),
    relatedIndependentReviewFindings: z.array(independentReviewRelationSchema).default([]),
    description: z.string().min(1),
  })
  .superRefine((finding, ctx) => {
    if (
      finding.postFixAssessment === "self-audit-caught-but-reproduced" &&
      finding.relatedFindingIds.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["relatedFindingIds"],
        message: "post-fix reproduced findings must link the self-audit finding that should have covered them",
      });
    }
  });
export type BrowserUseTestFinding = z.infer<typeof browserUseTestFindingSchema>;

export const browserUseTestFindingsFileSchema = z.object({
  model: z.string().min(1),
  reviewType: z.literal("browser-use-test"),
  source: z.string().min(1),
  findings: z.array(browserUseTestFindingSchema),
});
export type BrowserUseTestFindingsFile = z.infer<typeof browserUseTestFindingsFileSchema>;

export const verdictSchema = z.enum(["better", "same", "worse", "missing", "unknown"]);
export type Verdict = z.infer<typeof verdictSchema>;

export const comparisonEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9.-]+:C\d+$/, "expected '<model>:C{n}'"),
  model: z.string().min(1),
  code: z.string().regex(/^C\d+$/, "expected C{n}"),
  topic: z.string().min(1),
  verdict: verdictSchema,
  source: z.string().min(1),
  reference: z.string().min(1),
  compared: z.string().min(1),
  rationale: z.string().min(1),
});
export type ComparisonEntry = z.infer<typeof comparisonEntrySchema>;

export const comparisonEntriesFileSchema = z.object({
  model: z.string().min(1),
  reviewType: z.literal("comparison-vs-base"),
  source: z.string().min(1),
  entries: z.array(comparisonEntrySchema).min(1),
});
export type ComparisonEntriesFile = z.infer<typeof comparisonEntriesFileSchema>;

export const comparisonClusterSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  members: z
    .array(z.object({ entryId: z.string().min(1), note: z.string().optional() }))
    .min(1),
  notes: z.string().optional(),
});
export type ComparisonCluster = z.infer<typeof comparisonClusterSchema>;

export const comparisonClustersFileSchema = z.object({
  clusters: z.array(comparisonClusterSchema),
});
