import Link from "next/link";
import { textLinkClassName } from "./control-styles";

export function ComparisonReportLink({ comparisonId }: { comparisonId: string | undefined }) {
  if (!comparisonId) return null;
  return (
    <Link className={`${textLinkClassName} w-fit text-sm`} href={`/comparisons/${comparisonId}`}>
      View full comparison
    </Link>
  );
}
