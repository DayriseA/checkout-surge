import { destructiveResetReasonValues } from "@checkout-surge/contracts";
import { demoRuns } from "@checkout-surge/db";
import { and, eq, inArray, isNull } from "drizzle-orm";

export function incompleteAdminResetPredicate() {
  return and(
    eq(demoRuns.status, "failed"),
    inArray(demoRuns.failureReason, destructiveResetReasonValues),
    isNull(demoRuns.adminResetCompletedAt),
  );
}
