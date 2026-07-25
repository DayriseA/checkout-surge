import type {
  AcceptedRunConfigSnapshot,
  BackpressureConfig,
  BusinessOutcomeSummary,
  DemoPresetDisplay,
  ErpRunConfig,
  InventoryConfig,
  PublicRuntimePolicyMutable as PublicRuntimePolicyMutableContract,
  TerminalInventorySnapshot,
  TrafficConfig,
  TrafficDeliverySummary,
  TrafficHttpSummary,
  TransportAttemptCounts,
} from "@checkout-surge/contracts";
import type {
  demoPresets,
  demoRunFinalizations,
  demoRunSummaries,
  demoRuns,
  publicRuntimePolicies,
} from "../../src/schema.js";

type DemoPreset = typeof demoPresets.$inferSelect;
type NewDemoPreset = typeof demoPresets.$inferInsert;
type DemoRun = typeof demoRuns.$inferSelect;
type NewDemoRun = typeof demoRuns.$inferInsert;
type DemoRunFinalization = typeof demoRunFinalizations.$inferSelect;
type NewDemoRunFinalization = typeof demoRunFinalizations.$inferInsert;
type DemoRunSummary = typeof demoRunSummaries.$inferSelect;
type NewDemoRunSummary = typeof demoRunSummaries.$inferInsert;
type PublicRuntimePolicy = typeof publicRuntimePolicies.$inferSelect;
type NewPublicRuntimePolicy = typeof publicRuntimePolicies.$inferInsert;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type _PresetDisplaySelect = Expect<Equal<DemoPreset["display"], DemoPresetDisplay>>;
type _PresetTrafficSelect = Expect<Equal<DemoPreset["trafficConfig"], TrafficConfig>>;
type _PresetInventorySelect = Expect<Equal<DemoPreset["inventoryConfig"], InventoryConfig>>;
type _PresetErpSelect = Expect<Equal<DemoPreset["erpConfig"], ErpRunConfig>>;
type _PresetBackpressureSelect = Expect<
  Equal<DemoPreset["backpressureConfig"], BackpressureConfig>
>;
type _RunConfigSelect = Expect<Equal<DemoRun["configSnapshot"], AcceptedRunConfigSnapshot>>;
type _FinalizationHttpSelect = Expect<
  Equal<DemoRunFinalization["httpSummary"], TrafficHttpSummary>
>;
type _FinalizationTransportSelect = Expect<
  Equal<DemoRunFinalization["transportAttemptCounts"], TransportAttemptCounts>
>;
type _FinalizationDeliverySelect = Expect<
  Equal<DemoRunFinalization["trafficDeliverySummary"], TrafficDeliverySummary>
>;
type _SummaryHttpSelect = Expect<Equal<DemoRunSummary["httpSummary"], TrafficHttpSummary>>;
type _SummaryTransportSelect = Expect<
  Equal<DemoRunSummary["transportAttemptCounts"], TransportAttemptCounts>
>;
type _SummaryDeliverySelect = Expect<
  Equal<DemoRunSummary["trafficDeliverySummary"], TrafficDeliverySummary>
>;
type _SummaryBusinessOutcomeSelect = Expect<
  Equal<DemoRunSummary["businessOutcomeSummary"], BusinessOutcomeSummary>
>;
type _SummaryInventorySelect = Expect<
  Equal<DemoRunSummary["terminalInventorySnapshot"], TerminalInventorySnapshot | null>
>;
type _RuntimePolicySelect = Expect<
  Equal<PublicRuntimePolicy["policy"], PublicRuntimePolicyMutableContract>
>;
type _PresetDisplayInsert = Expect<Equal<NewDemoPreset["display"], DemoPresetDisplay>>;
type _PresetTrafficInsert = Expect<Equal<NewDemoPreset["trafficConfig"], TrafficConfig>>;
type _PresetInventoryInsert = Expect<Equal<NewDemoPreset["inventoryConfig"], InventoryConfig>>;
type _PresetErpInsert = Expect<Equal<NewDemoPreset["erpConfig"], ErpRunConfig>>;
type _PresetBackpressureInsert = Expect<
  Equal<NewDemoPreset["backpressureConfig"], BackpressureConfig>
>;
type _RunConfigInsert = Expect<Equal<NewDemoRun["configSnapshot"], AcceptedRunConfigSnapshot>>;
type _FinalizationHttpInsert = Expect<
  Equal<NewDemoRunFinalization["httpSummary"], TrafficHttpSummary>
>;
type _FinalizationTransportInsert = Expect<
  Equal<NewDemoRunFinalization["transportAttemptCounts"], TransportAttemptCounts>
>;
type _FinalizationDeliveryInsert = Expect<
  Equal<NewDemoRunFinalization["trafficDeliverySummary"], TrafficDeliverySummary>
>;
type _SummaryHttpInsert = Expect<Equal<NewDemoRunSummary["httpSummary"], TrafficHttpSummary>>;
type _SummaryTransportInsert = Expect<
  Equal<NewDemoRunSummary["transportAttemptCounts"], TransportAttemptCounts>
>;
type _SummaryDeliveryInsert = Expect<
  Equal<NewDemoRunSummary["trafficDeliverySummary"], TrafficDeliverySummary>
>;
type _SummaryBusinessOutcomeInsert = Expect<
  Equal<NewDemoRunSummary["businessOutcomeSummary"], BusinessOutcomeSummary>
>;
type _SummaryInventoryInsert = Expect<
  Equal<
    NewDemoRunSummary["terminalInventorySnapshot"],
    TerminalInventorySnapshot | null | undefined
  >
>;
type _RuntimePolicyInsert = Expect<
  Equal<NewPublicRuntimePolicy["policy"], PublicRuntimePolicyMutableContract>
>;

const validTrafficConfig: NewDemoPreset["trafficConfig"] = {
  mode: "buyer-spike",
  buyerCount: 10,
  duplicateEachBuyerAttempt: false,
  startDelaySeconds: 0,
  maxDurationSeconds: 10,
  quantityPerAttempt: 1,
};

// @ts-expect-error Preset traffic configuration must use a complete contract variant.
const invalidPresetConfig: NewDemoPreset["trafficConfig"] = { mode: "buyer-spike" };

// @ts-expect-error Run snapshots must contain all four accepted configuration sections.
const invalidRunSnapshot: NewDemoRun["configSnapshot"] = {
  trafficConfig: validTrafficConfig,
};

// @ts-expect-error Business outcome summaries cannot omit required durable counters.
const invalidBusinessOutcome: NewDemoRunSummary["businessOutcomeSummary"] = {
  acceptedReservations: 1,
};

// @ts-expect-error Terminal inventory is a structured contract snapshot, not arbitrary JSON.
const invalidTerminalInventory: NewDemoRunSummary["terminalInventorySnapshot"] = {
  source: "redis",
};

// @ts-expect-error Runtime-policy writes require the complete shared policy contract.
const invalidRuntimePolicy: NewPublicRuntimePolicy["policy"] = {
  isPublicRunBudgetEnforced: true,
};

void [
  invalidPresetConfig,
  invalidRunSnapshot,
  invalidBusinessOutcome,
  invalidTerminalInventory,
  invalidRuntimePolicy,
];
