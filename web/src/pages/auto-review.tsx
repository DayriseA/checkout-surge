import { useSearchParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClustersView } from "./clusters";
import { FindingsView } from "./findings";

type AutoReviewView = "findings" | "clusters";

export function AutoReviewPage() {
  const [params, setParams] = useSearchParams();
  const view: AutoReviewView = params.get("view") === "clusters" ? "clusters" : "findings";

  return (
    <div className="space-y-6">
      <header className="max-w-[70ch]">
        <h1 className="text-2xl font-semibold tracking-tight">Auto-Review</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          AI self-audit output across agents. Browse it as individual findings or switch to
          clusters for the editorial grouping of related issue classes.
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
        <TabsList aria-label="Auto-review views">
          <TabsTrigger value="findings">Findings</TabsTrigger>
          <TabsTrigger value="clusters">Clusters</TabsTrigger>
        </TabsList>

        <TabsContent value="findings">
          <FindingsView showHeader={false} />
        </TabsContent>

        <TabsContent value="clusters">
          <ClustersView showHeader={false} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
