# Delivery Constraints & System Guarantees

This document defines the core constraints, reference scenarios, and architectural guarantees for Checkout-Surge. Every subsequent commit and phase must preserve these properties.

## 1. The Reference Scenario

The system must continuously support the following limited-inventory checkout surge scenario:

- **The Surge**: 10,000+ synthetic buyers, the batch a virtual waiting room releases at once, attempt to buy a limited-stock offer in one unpaced k6 burst. The executor dispatches as fast as its host allows; this is not a one-second elapsed-time guarantee.
- **The Fast Path**: The declared target is p95 around ms level from immediately before the Node.js API calls the Redis stock-reservation gateway until its decision is received. Persistence and BullMQ publication occur afterward within the wider response path and are measured separately. Every result must identify its environment; this target is not an environment-independent guarantee.
- **The Buffer**: Successful reservations enqueue order-processing work onto a Redis-backed queue (BullMQ).
- **The Bottleneck**: Background workers pull from the queue and hit a Mock ERP. The ERP can intentionally be configured to be slow (e.g., 1500ms latency) and unstable (e.g., max TPS limits).
- **The Observation**: A real-time SSE dashboard, backed by API recovery reads and internal Redis Pub/Sub dashboard events, surfaces request surge, queue depth, inventory drain, and system lag.

The public `surge-10k` target is the product/demo goal, not just an upper configuration value. The underlying scenario is the purchase system behind a virtual waiting room facing a scarcity-driven checkout surge, rather than a requirement that the offer be a short promotional flash sale. Local laptop, Dev Container, and Codespaces runs may expose host-resource limits, and the hosted demo on Fly.io is not a benchmark environment, but code and design choices should first optimize the single-node hot path rather than lowering the public target.

## 2. Delivery Constraints

To ensure the project reaches its final goals cleanly, the following constraints apply to all phases:

- **Decoupled Architecture**: The API Gateway must NEVER communicate directly with the Mock ERP. All communication must pass through the asynchronous queue.
- **Fast Reservation, Slow Confirmation**: The buy flow contract must preserve the split between immediate reservation feedback and delayed final confirmation. The API may acknowledge a secured reservation quickly, but final order confirmation must remain asynchronous and reflect downstream ERP outcomes.
- **Built-In Realistic Load Simulation & Live Observability**: The load orchestrator and real-time monitoring dashboard are first-class deliverables of the system, not optional demo extras. The repository must eventually be able to generate synthetic pressure and surface live operational behavior from within the project itself.
- **API Traffic Is the Benchmark Surface**: High-volume buyers are represented by k6-generated HTTP traffic against the API, not by real browser sessions. The project should not include a customer storefront unless a later requirement proves it adds architectural value.
- **Runnable at Every Phase**: Every targeted commit must leave the repository in a runnable state. Use stubs if downstream services aren't built yet.
- **Configurable Chaos**: The Mock ERP and Load Orchestrator must always read their constraints (Latency, Max TPS, Virtual Users) from environment variables or a direct admin API, never hardcoded.
- **Realistic Simulation Over Real Commerce Integrations**: The project must prove the architecture and workflow boundaries without real customers, real payments, real email delivery, or required receipt storage. Post-confirmation notification behavior may be represented by durable simulated records, while Redis, queueing, persistence, workers, and observability remain real implementation surfaces.

## 3. The Core Benchmark Narrative (Portfolio Story)

The primary story of this project is **Resilience Under Extreme Pressure**.

- The project is _not_ just a standard e-commerce site; it is a demonstration of how to handle system pressure gracefully.
- All code reviews and architectural choices must prioritize the "Gold Signals" (Request Surge, Queue Depth, Inventory Drain, Consistency Lag) over UI polish.
- If the optional Go phase is reached, the architecture must support a fair, isolated side-by-side benchmark between Node.js and Go.

## 4. Cross-Cutting System Guarantees

No matter the scale of the load test, the completed system MUST guarantee:

1. **Zero Overselling**: Under no circumstances can the number of successful reservations exceed the stock allocated to the active sale offer.
2. **Controlled Backpressure**: Dispatch must stay within the downstream system's declared capacity, and a temporary downstream constraint must not cost accepted work, subject to recoverable infrastructure and eventual successful downstream opportunities. As implemented, the order-process queue is paced at the accepted snapshot's declared ERP capacity through its native rate limit and global concurrency, and the worker adds durable capacity cooldowns, a separate availability circuit with sparse probes, in-flight ceilings, and bounded observed-latency deadlines. A temporary constraint retains the affected order and extends its waiting time; only a non-transient technical error fails an order, and a reset — requested by an admin, or triggered automatically 900 seconds after acceptance — deliberately discards the run together with its in-flight work. The API Gateway should remain up and responsive, even if the background queue depth is massive.
3. **Observable Consistency Lag**: The system must track and expose the time difference between the initial buy request and the final ERP confirmation for every order.
4. **Auditable Simulation Outcomes**: A load run must expose a recap of attempted requests, accepted reservations, sold-out rejections, queued orders, final order outcomes, and simulated post-confirmation notifications so operators can verify that the emulated traffic was handled as expected.
