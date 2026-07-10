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
import { BrowserUseTestingView } from "./browser-use-testing";

type IndependentReviewView = "code-findings" | "code-clusters" | "browser-use";

/**
 * Findings from the fixed-reviewer pass over each agent's post-fix branch.
 * Unlike the self-audits (each model reviewing its own code), the reviewer is
 * held constant here, so finding counts are comparable across agents.
 */
export function IndependentReviewPage() {
  const [params, setParams] = useSearchParams();
  const requestedView = params.get("view");
  const view: IndependentReviewView =
    requestedView === "code-clusters" || requestedView === "browser-use"
      ? requestedView
      : "code-findings";

  return (
    <div className="space-y-6">
      <header className="max-w-[76ch]">
        <h1 className="text-2xl font-semibold tracking-tight">Independent review</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          The primary pass is a code review: a single fixed reviewer — <strong>{independentReviewer}</strong>{" "}
          — reviewed each agent's post-fix implementation branch with the same guide the self-audits
          used. Holding the reviewer constant removes the self-audit ambiguity where a low finding
          count can mean either clean code or a reviewer blind to its own issues, so these counts
          compare across agents. Each finding also records whether the branch's own self-audit caught
          the same issue class, or missed it. Note the review target is the <em>post-fix</em> branch
          state — compare across branches, not against the same branch's pre-fix self-audit totals. A
          smaller browser-use pass supplements that audit with observable behavior from real UI flows.
        </p>
      </header>

      <Tabs
        value={view}
        onValueChange={(nextView) => {
          const next = new URLSearchParams(params);
          if (nextView !== "code-findings") next.set("view", nextView);
          else next.delete("view");
          setParams(next, { replace: true });
        }}
      >
        <TabsList aria-label="Independent-review views">
          <TabsTrigger value="code-findings">Code findings</TabsTrigger>
          <TabsTrigger value="code-clusters">Code clusters</TabsTrigger>
          <TabsTrigger value="browser-use">Browser-use testing</TabsTrigger>
        </TabsList>

        <TabsContent value="code-findings">
          <FindingsView showHeader={false} findings={allIndependentFindings} />
        </TabsContent>

        <TabsContent value="code-clusters">
          <ClustersView
            showHeader={false}
            clusters={independentReviewClusters}
            resolveFinding={independentFindingById}
            jsonPath="results/data/independent-review-clusters.json"
            explorerPath="/independent-review?view=code-findings"
          />
        </TabsContent>

        <TabsContent value="browser-use">
          <BrowserUseTestingView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
