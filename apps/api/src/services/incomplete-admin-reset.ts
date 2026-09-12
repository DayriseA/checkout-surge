import { demoRuns } from "@checkout-surge/db";
import { and, eq, isNull } from "drizzle-orm";

export function incompleteAdminResetPredicate() {
  return and(
    eq(demoRuns.status, "failed"),
    eq(demoRuns.failureReason, "admin_reset"),
    isNull(demoRuns.adminResetCompletedAt),
  );
}
