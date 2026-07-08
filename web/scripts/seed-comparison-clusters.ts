/**
 * Seeds comparison clusters from the imported comparison entries.
 *
 * The mapping below is intentionally conservative. It groups entries only when
 * the reports are clearly discussing the same comparison concern. Any imported
 * entry not listed here is emitted as a singleton cluster so no source section
 * disappears from the browser.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface Entry {
  id: string;
  model: string;
  code: string;
  topic: string;
  verdict: string;
}

interface MemberSeed {
  entryId: string;
  note?: string;
}

interface ClusterSeed {
  id: string;
  title: string;
  description: string;
  confidence: "high" | "medium" | "low";
  members: Array<string | MemberSeed>;
  notes?: string;
}

const repoDir = fileURLToPath(new URL("../..", import.meta.url));
const dataDir = join(repoDir, "results", "data");
const entriesDir = join(dataDir, "comparison-entries");

const clusterSeeds: ClusterSeed[] = [
  {
    id: "durable-entity-model",
    title: "Durable entity model and schema coverage",
    description: "Coverage of the core durable PostgreSQL/domain entity model relative to the reference.",
    confidence: "high",
    members: ["glm-5.2:C1", "gpt-5.5:C1"],
  },
  {
    id: "lifecycle-status-vocabulary",
    title: "Lifecycle status vocabulary",
    description: "Canonical reservation, order, and run status vocabularies, including enum drift concerns.",
    confidence: "medium",
    members: [
      { entryId: "glm-5.2:C2", note: "Broader vocabulary-source discussion, not only lifecycle statuses." },
      "gpt-5.5:C2",
    ],
  },
  {
    id: "primitive-and-contract-strictness",
    title: "Primitive and contract strictness",
    description: "Refined primitive schemas, strict object contracts, and contract package boundary discipline.",
    confidence: "high",
    members: ["glm-5.2:C8", "gpt-5.5:C3"],
  },
  {
    id: "json-contract-specificity",
    title: "JSON contract specificity near persistence",
    description: "How strongly persisted JSON/configuration payloads are typed and validated.",
    confidence: "high",
    members: ["glm-5.2:C17", "gpt-5.5:C4"],
  },
  {
    id: "runtime-boundary-validation",
    title: "Runtime validation at service boundaries",
    description: "Runtime parsing of requests, responses, and cross-service payloads against shared contracts.",
    confidence: "medium",
    members: [
      { entryId: "glm-5.2:C94", note: "Focuses on outbound server response validation." },
      { entryId: "gpt-5.5:C5", note: "Covers validation discipline across several service boundaries." },
    ],
  },
  {
    id: "error-and-correlation-contracts",
    title: "Error payloads and correlation IDs",
    description: "Shared error response shape, error-code governance, and request correlation plumbing.",
    confidence: "medium",
    members: ["glm-5.2:C6", "glm-5.2:C93", "gpt-5.5:C6"],
  },
  {
    id: "realtime-event-and-metric-contracts",
    title: "Realtime event and metric contracts",
    description: "Dashboard event vocabulary, metric names, queue names, validation, and realtime contract drift.",
    confidence: "high",
    members: [
      { entryId: "glm-5.2:C7", note: "Combines realtime event and metric contract analysis." },
      "gpt-5.5:C7",
      "gpt-5.5:C8",
    ],
  },
  {
    id: "derived-purchase-status",
    title: "Derived simulated purchase status",
    description: "Buyer-facing presentation status derived from reservation/order state.",
    confidence: "high",
    members: ["glm-5.2:C4", "gpt-5.5:C9"],
  },
  {
    id: "buy-response-contract",
    title: "Buy response contract and taxonomy",
    description: "HTTP buy response body shape, status-code taxonomy, pending-persistence guidance, and validation.",
    confidence: "high",
    members: [
      { entryId: "glm-5.2:C5", note: "Also covers outcome headers." },
      "gpt-5.5:C34",
    ],
  },
  {
    id: "order-status-query-surface",
    title: "Order status lookup surface",
    description: "Read/query surface for order status and buyer-visible order state.",
    confidence: "medium",
    members: [
      { entryId: "glm-5.2:C27", note: "GLM combines order and inventory query surfaces." },
      "gpt-5.5:C10",
    ],
  },
  {
    id: "run-offer-ownership",
    title: "Generated run-offer ownership",
    description: "Run-scoped generated sale-offer ownership and enforcement.",
    confidence: "high",
    members: ["glm-5.2:C11", "gpt-5.5:C11"],
  },
  {
    id: "terminal-inventory-history",
    title: "Terminal inventory history persistence",
    description: "Sold-out and terminal inventory aggregates/snapshots persisted into durable history.",
    confidence: "medium",
    members: ["glm-5.2:C25", "gpt-5.5:C13"],
  },
  {
    id: "database-constraints-and-timestamps",
    title: "Database constraints and timestamp invariants",
    description: "CHECK constraints, non-enum invariants, and lifecycle timestamp guarantees in PostgreSQL.",
    confidence: "high",
    members: ["glm-5.2:C9", "glm-5.2:C16", "gpt-5.5:C14"],
  },
  {
    id: "postgresql-index-coverage",
    title: "PostgreSQL index coverage",
    description: "Index fit for run-scoped reads, history pagination, and operational query patterns.",
    confidence: "high",
    members: ["glm-5.2:C13", "gpt-5.5:C15"],
  },
  {
    id: "migration-hygiene",
    title: "Migration hygiene",
    description: "Migration metadata, hand-authored SQL quality, and schema evolution discipline.",
    confidence: "high",
    members: ["glm-5.2:C14", "gpt-5.5:C16"],
  },
  {
    id: "seed-data-idempotency",
    title: "Seed data and idempotency",
    description: "Seeded baseline data, re-seed behavior, and idempotent setup expectations.",
    confidence: "high",
    members: ["glm-5.2:C15", "gpt-5.5:C17"],
  },
  {
    id: "cleanup-and-retention",
    title: "Cleanup and retention tooling",
    description: "Old-run cleanup, retention controls, and targeted teardown behavior.",
    confidence: "high",
    members: ["glm-5.2:C37", "gpt-5.5:C18"],
  },
  {
    id: "redis-keyspace-isolation",
    title: "Redis keyspace isolation and hygiene",
    description: "Run isolation, key naming, reset hygiene, and cleanup of Redis inventory state.",
    confidence: "high",
    members: ["glm-5.2:C23", "gpt-5.5:C19", "gpt-5.5:C28"],
  },
  {
    id: "atomic-stock-gate",
    title: "Atomic stock gate and oversell safety",
    description: "Redis/Lua reservation gate atomicity and race-safety properties.",
    confidence: "high",
    members: ["glm-5.2:C18", "gpt-5.5:C20"],
  },
  {
    id: "idempotency-record-and-replay",
    title: "Idempotency record lifecycle and replay fidelity",
    description: "Accepted idempotency records, pending records, replay responses, and duplicate accepted accounting.",
    confidence: "high",
    members: ["glm-5.2:C19", "gpt-5.5:C21", "gpt-5.5:C35", "gpt-5.5:C41"],
  },
  {
    id: "idempotency-conflict-and-ttl",
    title: "Idempotency conflict and TTL edges",
    description: "Idempotency conflict rules plus TTL and expiry edge cases.",
    confidence: "high",
    members: ["glm-5.2:C20", "gpt-5.5:C22", "gpt-5.5:C29"],
  },
  {
    id: "sold-out-and-dashboard-volume",
    title: "Sold-out cheap path and dashboard volume",
    description: "Cheap sold-out paths, sold-out realtime cost, and dashboard aggregation under load.",
    confidence: "medium",
    members: ["glm-5.2:C21", "gpt-5.5:C23", "gpt-5.5:C39"],
  },
  {
    id: "pending-persistence-reconciliation",
    title: "Pending persistence and partial-state reconciliation",
    description: "Pending-persistence visibility, Redis sentinels, DB failure responses, and queue/promotion partial states.",
    confidence: "high",
    members: ["glm-5.2:C22", "gpt-5.5:C24", "gpt-5.5:C25", "gpt-5.5:C37", "gpt-5.5:C38"],
  },
  {
    id: "inventory-status-projection",
    title: "Inventory status projection",
    description: "Inventory status reads, uninitialized inventory behavior, and status projection from Redis state.",
    confidence: "high",
    members: ["glm-5.2:C24", "gpt-5.5:C26", "gpt-5.5:C27"],
  },
  {
    id: "run-sale-eligibility",
    title: "Run and sale eligibility gates",
    description: "Per-request eligibility closure for late buy traffic and sale/run state checks.",
    confidence: "high",
    members: ["glm-5.2:C38", "gpt-5.5:C32"],
  },
  {
    id: "traffic-classification",
    title: "Traffic and outcome classification",
    description: "Buy outcome headers, load-generator classification, traffic quality, and terminal reasons.",
    confidence: "high",
    members: ["glm-5.2:C34", "gpt-5.5:C33", "gpt-5.5:C48"],
  },
  {
    id: "surge-hot-path-and-tuning",
    title: "Surge hot path and runtime tuning",
    description: "PostgreSQL work on the accepted hot path plus service tuning and startup validation.",
    confidence: "medium",
    members: ["glm-5.2:C28", "gpt-5.5:C36", "gpt-5.5:C40"],
  },
  {
    id: "preset-catalog-and-run-config",
    title: "Preset catalog and run configuration snapshots",
    description: "Preset mutation controls, accepted run configuration snapshots, and public custom handling.",
    confidence: "high",
    members: ["glm-5.2:C29", "gpt-5.5:C42", "gpt-5.5:C43"],
  },
  {
    id: "generated-offers-inventory-init",
    title: "Generated offers and isolated inventory initialization",
    description: "Generated run sale offers and inventory setup scoped to the active run.",
    confidence: "high",
    members: ["glm-5.2:C30", "gpt-5.5:C44"],
  },
  {
    id: "one-active-run-gate",
    title: "One active-or-draining run gate",
    description: "Storage and start-time invariants that prevent concurrent active demo runs.",
    confidence: "high",
    members: ["glm-5.2:C12", "gpt-5.5:C45"],
  },
  {
    id: "traffic-completion-handoff",
    title: "Traffic completion handoff into draining",
    description: "Boundary between traffic completion and business-process draining.",
    confidence: "high",
    members: ["glm-5.2:C32", "gpt-5.5:C46"],
  },
  {
    id: "business-drain-finalization",
    title: "Business-drain finalization and timeout",
    description: "Drain-settlement gates, finalization, and timeout semantics.",
    confidence: "high",
    members: ["glm-5.2:C33", "gpt-5.5:C47"],
  },
  {
    id: "terminal-summary-history",
    title: "Terminal summary and failure-path history",
    description: "Failed-start handling, terminal summary idempotence, and history records.",
    confidence: "medium",
    members: ["glm-5.2:C31", "gpt-5.5:C49"],
  },
  {
    id: "startup-reconciliation",
    title: "Startup reconciliation and crash recovery",
    description: "API startup reconciliation of interrupted or draining runs.",
    confidence: "high",
    members: ["glm-5.2:C35", "gpt-5.5:C50"],
  },
  {
    id: "admin-reset-recovery",
    title: "Admin reset and live-run recovery",
    description: "Administrative reset workflows and recovery from live or wedged runs.",
    confidence: "high",
    members: ["glm-5.2:C36", "gpt-5.5:C51"],
  },
  {
    id: "downstream-retry-backpressure",
    title: "Downstream retry, timeout, and backpressure",
    description: "Order-processing retry policy, run-scoped ERP behavior, queue accumulation, and worker backpressure.",
    confidence: "high",
    members: ["glm-5.2:C39", "gpt-5.5:C52", "gpt-5.5:C53", "gpt-5.5:C54"],
  },
  {
    id: "circuit-breaker-behavior",
    title: "Circuit breaker behavior and run scoping",
    description: "Circuit-breaker state machine, retry cooperation, breaker-blocked retries, and run scoping.",
    confidence: "high",
    members: ["glm-5.2:C41", "gpt-5.5:C55", "gpt-5.5:C56"],
  },
  {
    id: "worker-order-lifecycle",
    title: "Worker order lifecycle and attempt history",
    description: "Order transition events, durable worker lifecycle, ERP attempt history, and terminality.",
    confidence: "high",
    members: ["glm-5.2:C40", "gpt-5.5:C57", "gpt-5.5:C58"],
  },
  {
    id: "consistency-lag-pipeline",
    title: "Consistency-lag and worker realtime milestones",
    description: "Worker realtime milestones and measurement/emission of consistency lag.",
    confidence: "high",
    members: ["glm-5.2:C44", "gpt-5.5:C59"],
  },
  {
    id: "notification-durability",
    title: "Post-confirmation notification durability",
    description: "Simulated notification follow-up durability, recovery, and post-confirmation work.",
    confidence: "high",
    members: ["glm-5.2:C43", "gpt-5.5:C60"],
  },
  {
    id: "mock-erp-chaos",
    title: "Mock ERP chaos controls",
    description: "Mock ERP chaos scoping, precedence, per-run behavior, and TPS realism.",
    confidence: "high",
    members: ["glm-5.2:C42", "gpt-5.5:C61"],
  },
  {
    id: "sse-transport-fanout",
    title: "Realtime transport fan-out and SSE mechanics",
    description: "SSE stream gateway behavior, fan-out mechanics, and transport validation.",
    confidence: "high",
    members: ["glm-5.2:C46", "gpt-5.5:C64"],
  },
  {
    id: "dashboard-recovery-read-model",
    title: "Dashboard recovery read model",
    description: "Authoritative dashboard recovery/read-model composition and terminal settle behavior.",
    confidence: "high",
    members: ["glm-5.2:C47", "gpt-5.5:C65"],
  },
  {
    id: "live-dashboard-signals",
    title: "Live dashboard signal completeness",
    description: "Live dashboard signal coverage, watch UX, and run-context storytelling.",
    confidence: "medium",
    members: ["glm-5.2:C59", "gpt-5.5:C66"],
  },
  {
    id: "realtime-failure-isolation",
    title: "Realtime failure isolation",
    description: "Internal realtime publication discipline and isolation from malformed or failed realtime events.",
    confidence: "medium",
    members: ["glm-5.2:C45", "gpt-5.5:C67"],
  },
  {
    id: "traffic-model-capacity",
    title: "Traffic model mapping and generator capacity",
    description: "Traffic mode mapping, virtual-user sizing, and generator capacity choices.",
    confidence: "high",
    members: ["glm-5.2:C51", "gpt-5.5:C68"],
  },
  {
    id: "attempt-identity-script-safety",
    title: "Attempt identity and script parameter safety",
    description: "Generated request scripts, attempt identity, and script-parameter safety.",
    confidence: "high",
    members: ["glm-5.2:C52", "gpt-5.5:C69"],
  },
  {
    id: "k6-output-terminal-accounting",
    title: "k6 output parsing and traffic accounting",
    description: "k6 output parsing, terminal summaries, completion accounting, and reconciliation.",
    confidence: "high",
    members: ["glm-5.2:C53", "gpt-5.5:C70", "gpt-5.5:C74"],
  },
  {
    id: "metric-completion-delivery",
    title: "Metric and completion delivery reliability",
    description: "Live k6 metric streaming, metric delivery, and completion-report reliability.",
    confidence: "high",
    members: ["glm-5.2:C54", "gpt-5.5:C71"],
  },
  {
    id: "load-run-lifecycle",
    title: "Load-run lifecycle and cancellation",
    description: "Load-run readiness, diagnostics, cancellation, and completion-report controls.",
    confidence: "high",
    members: ["glm-5.2:C55", "gpt-5.5:C72"],
  },
  {
    id: "containerized-k6-ownership",
    title: "Containerized k6 ownership",
    description: "Ownership boundary for running k6 and readiness of the load-generation service.",
    confidence: "high",
    members: ["glm-5.2:C50", "gpt-5.5:C73"],
  },
  {
    id: "web-route-split",
    title: "Web route split and public/operator surfaces",
    description: "Public/admin route split and browser-facing surface layout.",
    confidence: "high",
    members: ["glm-5.2:C56", "gpt-5.5:C75"],
  },
  {
    id: "web-bff-same-origin",
    title: "Web BFF and same-origin browser boundary",
    description: "Web backend-for-frontend proxy discipline, secret containment, reverse proxying, and same-origin boundaries.",
    confidence: "high",
    members: ["glm-5.2:C63", "glm-5.2:C75", "gpt-5.5:C76"],
  },
  {
    id: "frontend-realtime-recovery",
    title: "Frontend realtime recovery protocol",
    description: "Frontend recovery coordination and realtime state recovery protocol.",
    confidence: "high",
    members: ["glm-5.2:C57", "gpt-5.5:C77"],
  },
  {
    id: "frontend-reconnect-ux",
    title: "Reconnect and recovery-failure UX",
    description: "Browser SSE reconnect behavior and recovery-failure user experience.",
    confidence: "high",
    members: ["glm-5.2:C58", "gpt-5.5:C78"],
  },
  {
    id: "frontend-architecture",
    title: "Frontend architecture and testability",
    description: "Frontend decomposition, state architecture, and testability.",
    confidence: "high",
    members: ["glm-5.2:C64", "gpt-5.5:C79"],
  },
  {
    id: "public-admin-control-ux",
    title: "Public picker, custom run, and admin control UX",
    description: "Public custom-run form, admin console completeness, and control workflow ergonomics.",
    confidence: "medium",
    members: ["glm-5.2:C60", "glm-5.2:C62", "gpt-5.5:C80"],
  },
  {
    id: "run-history-admin-ux",
    title: "Run history and destructive admin UX",
    description: "Run-history surface and destructive admin flows in the browser.",
    confidence: "high",
    members: ["glm-5.2:C61", "gpt-5.5:C81"],
  },
  {
    id: "admin-session-cookie",
    title: "Admin session and cookie hygiene",
    description: "Admin session establishment, web proxy authorization chain, and cookie hygiene.",
    confidence: "high",
    members: ["glm-5.2:C67", "gpt-5.5:C82"],
  },
  {
    id: "internal-authorization-boundaries",
    title: "Admin and internal service-token boundaries",
    description: "Direct service authorization, admin/internal service tokens, and protected ingestion endpoints.",
    confidence: "medium",
    members: ["glm-5.2:C68", "gpt-5.5:C83", "gpt-5.5:C90"],
  },
  {
    id: "public-visitor-budget",
    title: "Public visitor identity and budget enforcement",
    description: "Public visitor identity, budget accounting, and spend/traffic limits.",
    confidence: "high",
    members: ["glm-5.2:C69", "gpt-5.5:C85"],
  },
  {
    id: "runtime-policy-hard-caps",
    title: "Runtime policy, hard caps, and custom-start authorization",
    description: "Public runtime policy, deployment hard caps, preset authorization, and custom-start controls.",
    confidence: "high",
    members: ["glm-5.2:C70", "gpt-5.5:C86", "gpt-5.5:C87"],
  },
  {
    id: "public-safe-run-history-dto",
    title: "Public-safe run-history DTO boundary",
    description: "Public-safe DTO boundaries for run history and related read models.",
    confidence: "high",
    members: ["glm-5.2:C73", "gpt-5.5:C88"],
  },
  {
    id: "destructive-operation-gates",
    title: "Destructive operation access gates",
    description: "Access gates protecting destructive administrative operations.",
    confidence: "high",
    members: ["glm-5.2:C72", "gpt-5.5:C89"],
  },
  {
    id: "runtime-topology-setup",
    title: "Reference runtime topology and setup lifecycle",
    description: "Reference runtime service topology, explicit setup/startup lifecycle, and local validation boundaries.",
    confidence: "high",
    members: ["glm-5.2:C74", "glm-5.2:C77", "gpt-5.5:C91"],
  },
  {
    id: "compose-env-startup",
    title: "Compose readiness, environment, and startup robustness",
    description: "Container environment propagation, compose readiness/startup robustness, and env-file mode separation.",
    confidence: "medium",
    members: ["glm-5.2:C78", "gpt-5.5:C92", "gpt-5.5:C95"],
  },
  {
    id: "container-image-construction",
    title: "Runtime image construction",
    description: "Container image construction, service targets, and runtime service packaging.",
    confidence: "high",
    members: ["glm-5.2:C76", "gpt-5.5:C93"],
  },
  {
    id: "dev-container-isolation",
    title: "Dev Container and Codespaces isolation",
    description: "Dev Container dependency-volume isolation and Codespaces-oriented development isolation.",
    confidence: "high",
    members: ["glm-5.2:C81", "gpt-5.5:C94"],
  },
  {
    id: "runtime-health-smoke",
    title: "Runtime health and smoke coverage",
    description: "Readiness health tooling plus non-mutating runtime smoke checks.",
    confidence: "high",
    members: ["glm-5.2:C79", "gpt-5.5:C96", "gpt-5.5:C97"],
  },
  {
    id: "mutating-dashboard-load-smoke",
    title: "Mutating dashboard-path load smoke",
    description: "Mutating dashboard-path load smoke and runtime smoke-load coverage.",
    confidence: "high",
    members: ["glm-5.2:C80", "gpt-5.5:C98"],
  },
  {
    id: "test-taxonomy-command-surface",
    title: "Test taxonomy and command surface",
    description: "Root test taxonomy, command contracts, and test command surface clarity.",
    confidence: "high",
    members: ["glm-5.2:C83", "gpt-5.5:C100"],
  },
  {
    id: "test-infrastructure-reset",
    title: "Test infrastructure and reset determinism",
    description: "Test infrastructure guardrails, reset determinism, schema self-healing, and parallel safety.",
    confidence: "medium",
    members: ["glm-5.2:C82", "glm-5.2:C84", "gpt-5.5:C101"],
  },
  {
    id: "hard-property-regression-tests",
    title: "Hard-property regression coverage",
    description: "Hot-path and hard-property regression coverage.",
    confidence: "high",
    members: ["glm-5.2:C26", "gpt-5.5:C102"],
  },
  {
    id: "service-boundary-testability",
    title: "API and service-boundary testability seams",
    description: "Service-boundary testability, dependency injection, and API seam quality.",
    confidence: "high",
    members: ["glm-5.2:C85", "gpt-5.5:C103"],
  },
  {
    id: "repo-quality-gates",
    title: "Repo-wide quality gates and conventions",
    description: "Repo-wide type, lint, test, and convention gates.",
    confidence: "high",
    members: ["glm-5.2:C87", "gpt-5.5:C104"],
  },
  {
    id: "readme-status-claims",
    title: "README status and feature claims",
    description: "README status, setup-command accuracy, and feature-claim fidelity.",
    confidence: "high",
    members: ["glm-5.2:C88", "gpt-5.5:C105"],
  },
  {
    id: "roadmap-auditability",
    title: "Roadmap auditability and completion tracking",
    description: "Roadmap status consistency, completion tracking, and auditability.",
    confidence: "high",
    members: ["glm-5.2:C89", "gpt-5.5:C106"],
  },
  {
    id: "design-doc-adaptation",
    title: "Design-doc adaptation to implementation",
    description: "Whether design docs were adapted to implementation reality or kept inherited target wording.",
    confidence: "high",
    members: ["glm-5.2:C90", "gpt-5.5:C107"],
  },
  {
    id: "historical-verification-evidence",
    title: "Historical verification evidence",
    description: "Implementation-history audit trail and evidence limitations around claimed verification.",
    confidence: "high",
    members: ["glm-5.2:C91", "gpt-5.5:C111"],
  },
  {
    id: "readiness-status-depth",
    title: "Readiness status endpoint depth",
    description: "Queue, ERP, readiness projections and service-side liveness/readiness endpoint depth.",
    confidence: "medium",
    members: ["glm-5.2:C48", "gpt-5.5:C114"],
  },
];

const entries = readEntries();
const entryIndex = new Map(entries.map((entry) => [entry.id, entry]));
const assigned = new Set<string>();

const clusters = clusterSeeds.map((seed) => {
  const members = seed.members.map((member) => {
    const normalized = typeof member === "string" ? { entryId: member } : member;
    if (!entryIndex.has(normalized.entryId)) {
      throw new Error(`Unknown comparison entry in cluster ${seed.id}: ${normalized.entryId}`);
    }
    if (assigned.has(normalized.entryId)) {
      throw new Error(`Comparison entry assigned more than once: ${normalized.entryId}`);
    }
    assigned.add(normalized.entryId);
    return normalized;
  });

  return { ...seed, members };
});

for (const entry of entries) {
  if (assigned.has(entry.id)) continue;
  clusters.push({
    id: `singleton-${slug(entry.model)}-${entry.code.toLowerCase()}`,
    title: entry.topic,
    description:
      "No confident cross-report match has been assigned yet. Kept as a standalone comparison entry so the original section remains visible.",
    confidence: "low",
    members: [{ entryId: entry.id }],
  });
}

writeFileSync(
  join(dataDir, "comparison-clusters.json"),
  `${JSON.stringify({ clusters }, null, 2)}\n`,
);

console.log(`Wrote ${clusters.length} comparison clusters for ${entries.length} entries.`);

function readEntries(): Entry[] {
  const files = readdirSync(entriesDir).filter((file) => file.endsWith(".json")).sort();
  return files.flatMap((file) => {
    const parsed = JSON.parse(readFileSync(join(entriesDir, file), "utf8")) as { entries: Entry[] };
    return parsed.entries;
  });
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
