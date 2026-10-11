import { comparisonDetailParamsSchema } from "@checkout-surge/contracts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ComparisonWatch } from "../../components/comparison-watch";
import { getComparisonDetail } from "../../lib/api";

export const metadata: Metadata = { title: "Comparison report" };
export const dynamic = "force-dynamic";

export default async function ComparisonPage({
  params,
}: {
  params: Promise<{ comparisonId: string }>;
}) {
  const parsed = comparisonDetailParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  return (
    <ComparisonWatch
      comparisonId={parsed.data.comparisonId}
      initialRead={await getComparisonDetail(parsed.data.comparisonId)}
    />
  );
}
