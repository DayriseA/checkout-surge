import { z } from "zod";
import { positiveIntegerSchema } from "./primitives.js";

/** Public-safe explanation of a traffic failure; raw generator output stays protected. */
export const runFailureDiagnosticSchema = z.discriminatedUnion("cause", [
  z.object({ cause: z.literal("virtual_user_limit"), maxVus: positiveIntegerSchema }).strict(),
  z.object({ cause: z.literal("unidentified") }).strict(),
]);

export type RunFailureDiagnostic = z.infer<typeof runFailureDiagnosticSchema>;
