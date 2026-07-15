# Task 51: Deepen the non-mutating smoke's SSE check to observe an actual frame

## Execution context

- **Execution order:** This is task 51 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P2
- **Area:** smoke tooling
- **Source:** comparison (worse)
- **Standalone implementation context:** inlined below. No donor checkout, branch switch, or reference-project access is required.
- **Locations:** `scripts/runtime-smoke.mjs`, especially `checkDashboardSse()` (currently around line 104)

The smoke verifies status and `text/event-stream` content type, then aborts without waiting for a heartbeat or event frame — the single most proxy-sensitive path (SSE buffering) goes unverified. Small change: read until the first frame with a timeout.

## Standalone implementation context

### Current target behavior and exact gap

`pnpm runtime:smoke` runs `node scripts/run-with-env.mjs node scripts/runtime-smoke.mjs`. The smoke is intentionally non-mutating: it validates the running Compose topology, delegates direct readiness checks to `scripts/runtime-health-check.mjs`, verifies that k6 executes in the `load-orchestrator` container, reads `/api/dashboard/recovery` through the public origin, and probes the SSE route through that same origin.

Only the last probe is too shallow. Its current implementation is effectively:

```js
async function checkDashboardSse() {
  const baseUrl = envUrl("WEB_BASE_URL", "http://localhost:8080");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${baseUrl}/dashboard/events`, {
      cache: "no-store",
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      throw new Error(`Unexpected content-type: ${contentType || "missing"}.`);
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
```

Keep the same public URL and request metadata:

- URL: `${envUrl("WEB_BASE_URL", "http://localhost:8080")}/dashboard/events`.
- Method: the `fetch` default `GET`.
- Headers/options: `accept: text/event-stream`, `cache: no-store`, and an `AbortSignal`.
- Header success: an HTTP success response (`response.ok`) whose `content-type` includes `text/event-stream`.

After those checks, consume `response.body` and do not report success until a complete meaningful SSE frame has crossed the proxy. A successful status and content type prove only that Caddy reached the API and forwarded response headers. They do not prove that a long-lived response body is flushed incrementally: Caddy or a future proxy change could buffer the stream while this smoke still passes. The purpose of this task is to exercise that body-delivery boundary.

### Target wire format and required adaptation

The browser path is deliberately same-origin. `infra/caddy/Caddyfile` handles exactly `/dashboard/events` and reverse-proxies it directly to `api:4000`; all other paths go to `web:3000`. The probe must continue to use `WEB_BASE_URL` so it tests Caddy, not a direct `API_BASE_URL` shortcut.

`apps/api/src/realtime/dashboard-event-fanout.ts` defines the target stream behavior:

- On connection it returns `200` with `content-type: text/event-stream; charset=utf-8`, `cache-control: no-cache, no-transform`, `connection: keep-alive`, `x-accel-buffering: no`, and the correlation-ID response header.
- It immediately writes the control frame `retry: 3000\n: connected\n\n` (the retry value is configurable internally, so the smoke should not require exactly `3000`).
- Its default heartbeat interval is `15_000` ms, and each heartbeat is `: heartbeat <ISO timestamp>\n\n`.
- Published dashboard events are data-only frames: `data: <contract-valid JSON>\n\n`. Unlike the reference project, target event frames do not begin with an `event:` field.

Therefore, merely reading the first complete frame is not enough in this checkout: the immediate retry/connected control frame would make the check little stronger than the existing header-only check. Parse complete frames, ignore that opening control frame, and succeed on the first frame that is either:

- a heartbeat comment whose normalized frame contains a line beginning `: heartbeat `; or
- a real dashboard event containing at least one line beginning `data:`.

The smoke is non-mutating and must not publish an event just to satisfy itself, so its deterministic idle-runtime path is the heartbeat. Set the overall timeout above the target's 15-second default heartbeat interval. The reference uses 25 seconds for a 20-second heartbeat; 25 seconds is also an appropriate fixed budget here and leaves scheduling/proxy margin. Do not retain the current five-second budget, which must expire before the default heartbeat can occur. Do not weaken production heartbeat timing to make the smoke faster.

### Frame reader/parser requirements

Use the Fetch body reader (`response.body.getReader()`) and a streaming `TextDecoder`, or an equivalently bounded streaming implementation. The reader must handle all normal chunk boundaries:

- one frame split across several network chunks;
- several frames delivered in one chunk;
- UTF-8 decoding across chunk boundaries;
- LF (`\n\n`) and CRLF (`\r\n\r\n`) frame terminators;
- the opening control frame followed by the meaningful frame in either the same chunk or later chunks.

Do not equate one transport chunk with one SSE frame. Append decoded text to a small buffer, extract every complete frame in order, normalize line endings for classification, and retain only the incomplete suffix. A practical classifier is line-based: ignore blank lines; accept when any line starts with `: heartbeat ` or `data:`; otherwise continue waiting. Include the unexpected frame or timeout context in failure messages without assuming that event JSON will always be present.

If `response.body` is absent, fail explicitly (for example, `SSE response did not include a readable body.`). If the reader returns `done: true` before a heartbeat/event frame, fail explicitly rather than accepting the headers. If the deadline expires, surface a clear timeout such as `SSE stream timed out waiting for a heartbeat or event frame after 25000ms.`; preserve the underlying cause for unrelated request failures where practical.

### Resource and connection cleanup

The helper owns a deliberately long-lived HTTP response and must release it on every path: success, bad HTTP status, wrong content type, missing body, early EOF, timeout, parser failure, or network failure.

- Create one `AbortController` for the request and one timeout handle for the complete request-plus-frame wait.
- In `finally`, always clear the timeout, cancel/release the body reader if one was acquired, and abort the controller so the client socket closes promptly. Treat cleanup as best-effort so a cancellation error does not hide the primary assertion failure.
- Do not leave a pending `reader.read()`, timer, undici connection, or server-side SSE client after the step settles.
- Keep cleanup idempotent because the timeout and the main control flow can race.

Aborting the client request is also server cleanup: the API listens for request/response close, removes the client from its fan-out registry, and stops its shared heartbeat timer when the last client disconnects. Do not change API connection lifecycle, heartbeat code, Caddy configuration, or shutdown ordering in this smoke-tooling task.

### Reference behavior incorporated, with limits

The `checkout-forge` reference implements this stronger guarantee in `scripts/runtime-smoke-check.mjs`:

- `checkSseThroughProxy()` calls `requestSseStream(`${webBaseUrl}/dashboard/events`)`, then requires a 2xx status, a content type containing `text/event-stream`, and `isSseFrame(result.firstFrame)`.
- `requestSseStream()` uses Node `http`/`https`, sends `accept: text/event-stream`, accumulates UTF-8 response data until `\n\n`, returns the first complete frame, rejects if the stream ends first, and applies a 25-second socket timeout.
- Its single guarded `finish()` path marks the operation settled, destroys the request, and then resolves or rejects, preventing duplicate settlement and leaking the open SSE socket.
- `isSseFrame()` accepts `: heartbeat\n\n` or a frame beginning `event: `.
- The reference API emits no opening data/control frame after flushing headers, uses a 20-second default heartbeat (`: heartbeat\n\n`), and serializes events with `event: <type>` plus `data: <json>`.

Those mechanics establish the intended body-delivery, timeout, and teardown guarantees, but the reference parser must not be copied literally. Its `event:` predicate would reject this target's data-only events, its exact heartbeat string would reject the target's timestamped heartbeat, and returning the first frame without filtering would accept the target's immediate retry/connected frame. Its delimiter recognizes only LF; supporting CRLF in the target avoids coupling the smoke to one hop's newline preservation.

The primary and selective donor worktrees do not solve this exact task. The Opus smoke reads an immediate chunk and checks for `retry:`, which proves some body bytes crossed the proxy but does not wait for the heartbeat/event requested here. The GLM smoke checks only response status and content type, like the current target. Use the reference design, adapted to the target wire format above.

### Startup-order caveats

Run this smoke only after the runtime has been brought up and its services are healthy. Task 50 immediately before this task strengthens initial Compose health gates for web and `dashboard-proxy`; this task should consume that startup contract, not add polling, retries, sleeps, Compose mutations, or app startup to the smoke.

The 25-second frame deadline is a body-delivery deadline, not a substitute for readiness. If the proxy/API is unavailable, the existing status/network failure should remain immediate. Compose health gating applies during initial creation only and does not guarantee that an already-running dependency stays healthy; the smoke should report such a runtime failure, not attempt recovery. `runtime:smoke` must remain read-only and must not invoke `runtime:up`, `runtime:setup`, resets, seed operations, load runs, or event publication.

## Implementation boundaries and non-goals

- Keep the change owned by `scripts/runtime-smoke.mjs`; a tiny pure parser/helper module and focused test are acceptable only if needed for clean automated coverage. Do not change application, contract, database, web, Compose, Dockerfile, or proxy behavior.
- Preserve every existing smoke step, step name, failure aggregation, `WEB_BASE_URL` normalization, and non-mutating behavior. Deepen only `dashboard_sse_reachable`.
- Continue checking the same-origin `/dashboard/events` route. Do not probe the API port directly, use browser `EventSource`, add credentials/cookies, or introduce a third-party SSE package.
- Do not require a live business event, publish to Redis, start a load run, alter heartbeat/retry intervals, validate event payload schemas, add replay/event IDs, or turn this into a reconnection test.
- Bound memory while parsing. The endpoint emits tiny frames; do not collect the unending response body or call `response.text()`/`arrayBuffer()`.
- Preserve clear HTTP/content-type failures before waiting on the body. A heartbeat/event frame is an additional success criterion, not a replacement for existing checks.

## Focused verification

No app, Compose service, load run, or network request is required for parser-focused verification. Add focused automated coverage at the script/helper boundary if the chosen structure makes it practical, proving at minimum:

1. A timestamped heartbeat split across chunks is accepted only after its blank-line terminator arrives.
2. A `data:` event frame is accepted, including when it follows the retry/connected control frame in the same chunk.
3. The retry/connected control frame alone is ignored.
4. CRLF-delimited frames and multiple frames in one chunk are parsed correctly.
5. EOF before a meaningful frame and an absent response body fail clearly.
6. Timeout aborts the request, and success/failure both clear the timer and cancel/release the reader without double settlement.

Then perform these checks in an environment where the already-running runtime is intentionally available:

1. Run `node --check scripts/runtime-smoke.mjs` (and the focused parser test command, if added).
2. Run `pnpm runtime:smoke`. Confirm `dashboard_sse_reachable` does not pass immediately on the retry/connected frame; on an otherwise idle runtime it should pass after the first heartbeat, roughly 15 seconds after connection.
3. Temporarily using a non-delivering/buffering test endpoint, or a unit-test fake response, confirm the check fails near 25 seconds with the heartbeat/event timeout rather than hanging. Do not commit proxy changes for this experiment.
4. Confirm the process exits promptly after both pass and fail cases and the API no longer counts the smoke connection after completion.
5. Re-run the ordinary script/static checks affected by any helper extraction. Full application suites are unnecessary unless application code was changed, which is outside this task.

## Implementation record

- **Status:** Complete (2026-07-15).
- **Completed scope:** `dashboard_sse_reachable` still requests the public `WEB_BASE_URL/dashboard/events` path with default GET, `cache: no-store`, and `Accept: text/event-stream`, and still performs the existing HTTP/content-type checks. It now waits under one 25,000 ms request-plus-frame deadline for a complete timestamped heartbeat or `data:` frame, ignores control-only frames, incrementally decodes UTF-8 across chunks, recognizes LF and CRLF delimiters, and independently bounds each complete frame and the retained incomplete suffix without rejecting an aggregate chunk of individually small frames. All exit paths clear the deadline, abort the request, and best-effort cancel/release an acquired reader. Existing smoke steps, names, failure aggregation, and non-mutating behavior are unchanged.
- **Design decisions/deviations:** Extracted the focused request/reader/parser lifecycle to `scripts/runtime-smoke-sse.mjs` so it can be tested without executing the full Compose smoke. This helper is used only by the non-mutating smoke and is not coupled to the mutating load smoke. No requirement deviations.
- **Tests/docs:** Added `scripts/runtime-smoke-sse.test.mjs` and wired it into `test:scripts`. Coverage includes split heartbeat termination, a data frame after the opening control frame, UTF-8 split between bytes, control-only EOF, CRLF/multiple frames, an aggregate chunk larger than the configured limit whose individual frames remain bounded, distinct complete/incomplete frame overflow failures, retained HTTP/content-type failures, absent body, timeout abort, timer cleanup, reader cancellation/release, and late read settlement. Updated `docs/local_development.md` and `docs/runtime_topology.md` to state the complete-frame guarantee and expected idle heartbeat latency.
- **Verification:** `node --check scripts/runtime-smoke.mjs`; `node --check scripts/runtime-smoke-sse.mjs`; `node --check scripts/runtime-smoke-sse.test.mjs`; `node --test scripts/runtime-smoke-sse.test.mjs` (12 passed); `pnpm test:scripts` (39 passed); `pnpm type-check` (11 Turbo tasks passed across 8 packages); targeted `pnpm exec biome check scripts/runtime-smoke.mjs scripts/runtime-smoke-sse.mjs scripts/runtime-smoke-sse.test.mjs package.json docs/local_development.md docs/runtime_topology.md` (passed); `pnpm lint` (passed, 345 files); `git diff --check` (passed). `pnpm format:check` reported 47 unrelated pre-existing formatting/import diagnostics outside the Task 51 files; the targeted check passed.
- **Skipped runtime verification:** `docker compose ps --format json` returned no running services. Per the task boundary, the runtime was not started or mutated, so `pnpm runtime:smoke`, live ~15-second heartbeat timing, and live API client-count teardown checks were skipped. The fake-response test verifies the bounded timeout and prompt success/failure cleanup at the changed boundary.
