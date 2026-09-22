export const fieldHints = {
  trafficPattern:
    "How buyers arrive. Everyone at once: a fixed crowd checks out at the same instant, like a flash sale opening. Steady stream: new buyers keep arriving at a constant rate for a set time.",
  buyerCount:
    "How many simulated shoppers try to buy at the same moment. Each one tries to reserve one unit. When there are more buyers than stock, the extra ones are turned away as sold out.",
  duplicateBuyerAttempt:
    "Simulates an impatient shopper who clicks Buy twice. Both clicks carry the same request key, so the API recognizes the repeat and returns the same reservation instead of taking a second unit.",
  arrivalRate:
    "How many new checkout attempts the load generator starts every second, for the whole traffic duration. Delivery can fall short of this target if the generator cannot keep up.",
  trafficDuration:
    "How long new buyers keep arriving. Order processing continues after traffic stops, so the run usually lasts longer than this.",
  plannedAttempts:
    "Every checkout request the load generator will send: buyers (×2 with duplicates), or arrival rate × duration. It must stay within the public limit.",
  startingStock:
    "Units for sale when the run starts. Each successful reservation takes one. Set it below the buyer count to see sold-out rejections. Whatever the load, the system must never sell more than this.",
  erpDelay:
    "Extra time the simulated ERP takes to answer each confirmation call. Reservations stay fast because stock is secured before the ERP is called. Orders simply wait longer in the backlog.",
  erpCapacity:
    "The most confirmation calls per second the simulated ERP accepts. Calls above that rate are refused and retried later, so a low capacity makes the order backlog grow, then drain slowly.",
  erpFailureRate:
    "The share of confirmation calls the simulated ERP fails at random with a temporary error. The worker retries them, so this is not the share of orders that end up failed.",
  safetyCutoff:
    "A time limit on sending the spike, not on the whole run. If some attempts are still unsent when it expires, the load generator stops and the run reports partial delivery. Order processing continues afterwards.",
  startDelay:
    "How long the load generator waits after the run is accepted before sending the first buyer. Use it to open the live view on an idle system first.",
  advancedProtection: "Safety limits around the load generator. The defaults suit most runs.",
} as const;

export const adminFieldHints = {
  currentRun:
    "The run currently holding the shared demo. Only one run can be active at a time; new starts are blocked until it finishes or is reset.",
  sharedDependencies:
    "Health checks of the services a run needs: database, Redis, queue, load generator, simulated ERP. Runs cannot start while a required dependency is not ready.",
  presets:
    "A preset is a saved scenario: traffic, stock, simulated ERP and worker settings. Public presets are the cards visitors see. Admin presets exist only here. You can also start a one-off run with edited values without saving them.",
  erpFallback:
    "Live controls of the simulated ERP service itself. Each run carries its own frozen ERP settings, so changes here never affect a running run. They apply only to ERP calls that carry no run settings, and reset when the Mock ERP restarts.",
  fallbackLatency: `${fieldHints.erpDelay} Applies to calls that carry no run settings.`,
  fallbackCapacity: `${fieldHints.erpCapacity} Applies to calls that carry no run settings.`,
  fallbackErrorRate: `${fieldHints.erpFailureRate} Applies to calls that carry no run settings.`,
  recovery:
    "Operator tools. Reset stops all demo work immediately and frees the demo. Cleanup permanently deletes old generated runs from the history.",
  publicPolicy:
    'Rules for anonymous visitors: how many runs they may start, the values pre-filled in "Customize a scenario", and the limits on what they may enter. Runs already accepted keep their own snapshot.',
  slug: "Permanent technical identifier, used by the API and in run history. It cannot be edited; duplicate the preset to get a new one.",
  visibility:
    "public: shown to every visitor as a preset card and read-only here. admin: visible only in this console, and editable.",
  custom:
    'Marks a scratch scenario: the admin "Custom" preset or the base of the public "Customize a scenario" form. Scratch scenarios cannot be archived.',
  presetName: "Display name shown in preset lists and, for public presets, on the visitor card.",
  presetDescription:
    'Short explanation of what this scenario demonstrates and what a viewer should notice. Shown under "Technical details" on public cards.',
  sortOrder: "Position in preset lists. Lower numbers come first.",
  duplicateSlug:
    "Identifier for the new admin-only copy of the selected preset. The copy takes the saved values, not unsaved edits.",
  copyToCustom:
    'Overwrites the admin "Custom" scratch preset with this preset\'s saved values, so you can experiment without touching the original. It does not change the public form.',
  vuserPool:
    "Virtual users (VUs) are the load generator's reusable workers; each sends one request at a time. This many are ready before traffic starts. Too few for the rate and attempts are skipped, reported as partial delivery.",
  maxVus:
    "The most virtual users the load generator may add when responses slow down and every prepared one is busy. At least the preallocated count. For visitors, both values are derived from the arrival rate.",
  queueName: "Logical queue name and the underlying BullMQ queue. Fixed, shown for traceability.",
  publicBudget:
    'Limits how many runs anonymous visitors may start per time window, per visitor and overall. "Budget" counts starts, not money. Off: visitors may start whenever the demo is free; configuration limits still apply.',
  budgetWindow:
    "Length of each counting period for public starts (3600 = one hour). Windows are fixed, not rolling: counters reset at each boundary.",
  visitorStarts:
    "Most runs one visitor may start per window. Visitors are recognized by an anonymous browser credential, not an account.",
  globalStarts:
    "Most runs all visitors together may start per window. Protects the shared host from a crowd of visitors.",
  publicDefaults:
    'The values pre-filled in the public "Customize a scenario" form. Settings visitors cannot edit (worker concurrency, VUs) are always taken from here.',
  publicLimits:
    'The highest (or lowest) values visitors may enter in "Customize a scenario". They constrain choices; they do not set a run\'s values. Each must stay within the deployment hard caps below.',
  allowTrafficModes:
    'Which traffic patterns visitors may pick ("Everyone at once" / "Steady stream"). At least one must stay allowed.',
  perRunErp:
    'Simulated ERP behaviour frozen into every run started from this preset. It takes precedence over the global "ERP fault injection" values.',
  workerBackpressure:
    "How the background worker pulls orders from the queue. Backpressure means the queue absorbs the surge so the slow ERP only receives what it can handle.",
  effectiveRunPreview:
    "The exact configuration the run would receive if started now, with your edits merged onto defaults. On start it becomes the run's frozen snapshot, visible later in run history.",
  deploymentHardCaps:
    "Absolute ceilings set by the server's environment configuration to protect the host. Not editable here. Every preset and public limit must stay below them.",
  adminPassphrase:
    "The admin passphrase provided by the project owner. It unlocks the operator controls.",
  identifierType:
    "The kind of identifier you copied: an internal database order ID, the public order ID returned by checkout, or a correlation ID used to trace one request.",
  identifier:
    "Finds records of this run matching the identifier exactly, including records outside the recent view.",
} as const;

export const adminDraftFieldHints: Record<string, string> = {
  buyerCount: fieldHints.buyerCount,
  duplicateEachBuyerAttempt: fieldHints.duplicateBuyerAttempt,
  maxDurationSeconds: `Shown to visitors as "Safety cutoff". ${fieldHints.safetyCutoff}`,
  ratePerSecond: `Shown to visitors as "Arrival rate". ${fieldHints.arrivalRate}`,
  durationSeconds: `Shown to visitors as "Traffic duration". ${fieldHints.trafficDuration}`,
  preAllocatedVus: adminFieldHints.vuserPool,
  maxVus: adminFieldHints.maxVus,
  startDelaySeconds: fieldHints.startDelay,
  startingStock: fieldHints.startingStock,
  erpLatencyMs: `Shown to visitors as "Delay per order". ${fieldHints.erpDelay}`,
  erpMaxTps: `Shown to visitors as "Capacity". ${fieldHints.erpCapacity} TPS means transactions (confirmation calls) per second. Over the limit the ERP answers HTTP 429 and the worker backs off.`,
  erpErrorRate: `Shown to visitors as "Failure rate". ${fieldHints.erpFailureRate} Injected failures are HTTP 503. Runs declaring more than 30% are refused at start because their duration cannot be estimated.`,
  erpForcedOutage:
    "Makes the simulated ERP refuse every confirmation for this run. A run declared this way is refused at start because its duration cannot be estimated. It is kept for completeness of the snapshot, not as a working scenario.",
  orderProcessConcurrency:
    "How many orders the worker processes in parallel for this run. Higher values drain the backlog faster but push harder on the ERP, which still enforces its own capacity. Also feeds the admission duration estimate.",
  budgetWindowSeconds: adminFieldHints.budgetWindow,
  perVisitorMaxStarts: adminFieldHints.visitorStarts,
  globalMaxStarts: adminFieldHints.globalStarts,
  maxTotalRequests:
    "Upper limit on a visitor run's planned total attempts: buyers (×2 with duplicates), or rate × duration.",
  maxBuyers: 'Highest value visitors may enter for "Buyer count".',
  maxRequestsPerSecond: 'Highest value visitors may enter for "Arrival rate".',
  maxTrafficDurationSeconds:
    'Highest value visitors may enter for "Traffic duration" and for "Safety cutoff".',
  maxTrafficStartDelaySeconds: 'Highest value visitors may enter for "Start delay".',
  maxPreAllocatedVus:
    "Visitors do not set virtual users; they are derived from the arrival rate. This caps the derived values, so it indirectly limits the arrival rate a visitor can use.",
  maxPublicVus:
    "Visitors do not set virtual users; they are derived from the arrival rate. This caps the derived values, so it indirectly limits the arrival rate a visitor can use.",
  maxStartingStock: 'Highest value visitors may enter for "Starting stock".',
  maxErpLatencyMs: 'Highest value visitors may enter for "Delay per order".',
  minErpMaxTps:
    'Lowest "Capacity" visitors may choose. Stops a visitor from making the ERP so slow that the run cannot finish within the demo time limit.',
  maxErpMaxTps: 'Highest value visitors may enter for "Capacity".',
  maxErpErrorRate: 'Highest "Failure rate" visitors may choose.',
};
