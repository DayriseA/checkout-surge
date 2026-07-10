import { useSearchParams } from "react-router-dom";
import {
  allIndependentFindings,
  independentFindingById,
  independentReviewClusters,
  independentReviewer,
} from "@/lib/data";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClustersView } from "./clusters";
import { FindingsView } from "./findings";

type IndependentReviewView = "findings" | "clusters";

/**
 * Findings from the fixed-reviewer pass over each agent's post-fix branch.
 * Unlike the self-audits (each model reviewing its own code), the reviewer is
 * held constant here, so finding counts are comparable across agents.
 */
export function IndependentReviewPage() {
  const [params, setParams] = useSearchParams();
  const view: IndependentReviewView = params.get("view") === "clusters" ? "clusters" : "findings";

  return (
    <div className="space-y-6">
      <header className="max-w-[76ch]">
        <h1 className="text-2xl font-semibold tracking-tight">Independent review</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          A single fixed reviewer — <strong>{independentReviewer}</strong> — code-reviewed each
          agent's post-fix implementation branch with the same guide the self-audits used. Holding
          the reviewer constant removes the self-audit ambiguity where a low finding count can mean
          either clean code or a reviewer blind to its own issues, so these counts compare across
          agents. Each finding also records whether the branch's own self-audit caught the same
          issue class, or missed it. Note the review target is the <em>post-fix</em> branch state —
          compare across branches, not against the same branch's pre-fix self-audit totals.
        </p>
      </header>

      <Tabs
        value={view}
        onValueChange={(nextView) => {
          const next = new URLSearchParams(params);
          if (nextView === "clusters") next.set("view", "clusters");
          else next.delete("view");
          setParams(next, { replace: true });
        }}
      >
        <TabsList aria-label="Independent-review views">
          <TabsTrigger value="findings">Findings</TabsTrigger>
          <TabsTrigger value="clusters">Clusters</TabsTrigger>
        </TabsList>

        <TabsContent value="findings">
          <FindingsView showHeader={false} findings={allIndependentFindings} />
        </TabsContent>

        <TabsContent value="clusters">
          <ClustersView
            showHeader={false}
            clusters={independentReviewClusters}
            resolveFinding={independentFindingById}
            jsonPath="results/data/independent-review-clusters.json"
            explorerPath="/independent-review"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
