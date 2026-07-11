# Task 42: Use k6 summary-export for terminal reports and make a real-k6 test lane mandatory

## Execution context

- **Execution order:** This is task 42 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P2
- **Area:** load-orchestrator / test infrastructure
- **Source:** comparison (worse) + independent review (note)
- **Standalone reference context:** the relevant reference implementation, compatibility behavior, target-specific adaptation, and verification fixtures are inlined below; no other repository or branch is required.
- **Locations:** `apps/load-orchestrator/src/application/k6-output-parser.ts`, `apps/load-orchestrator/test/load-orchestrator.test.ts:139`

Terminal reports are computed entirely from the streamed point accumulator (with an in-memory latency array for p95); no summary export, no fallback parser, no resilience to point-stream loss or k6 output drift. Meanwhile the only real `k6 inspect` compatibility test is skipped when no binary exists — the audit observed the skip — so script/options incompatibility can reach runtime. Add a mandatory k6-equipped lane (k6 already ships in the orchestrator image).

## Standalone reference findings

### Summary-export ownership and process flow

The useful reference code is split by responsibility rather than embedded in the generated scenario:

- `apps/load-orchestrator/src/k6-script.ts::createK6Script()` defines the scenario and custom checkout outcome counters. It does **not** define `handleSummary()`.
- `apps/load-orchestrator/src/load-runner.ts::LoadRunner.spawnK6()` creates `<run temp dir>/summary.json` and invokes k6 with the argv array `run --summary-export <summaryPath> --out json=- <scriptPath>`. The path is never interpolated into a shell command. JSON points on stdout continue to feed live metrics and rolling point aggregates.
- On child close, the runner waits for `readSummaryExport(summaryPath, stdoutTail)` before constructing or sending the terminal report. The temp directory is removed only after this work completes. Thus a valid zero exit alone is not allowed to race terminal-summary reading or cleanup.
- `readSummaryExport()` reads the file as UTF-8 and calls `parseK6SummaryMetrics()`. A parsed object with no supported metrics is treated as invalid; an absent file (`ENOENT`) and another read failure are distinguished. In all three cases the runner attempts `parseK6SummaryMetrics(stdout)` and records a structured warning (`summary_export_invalid`, `summary_export_missing`, or `summary_export_read_failed`).
- The reference keeps only a bounded 256 KiB stdout tail for that fallback while line-by-line parsing consumes the full point stream. `createBoundedStdoutTail()` appends buffers and drops oldest complete chunks until retaining another chunk would go below the cap. This bounds memory, though a single very large chunk may exceed the nominal cap. Surge need not copy the chunk implementation if it can enforce a stricter byte ring, but must not retain unbounded stdout.

The stdout fallback is best effort, not a second guaranteed k6 export. Because the reference script has no `handleSummary()`, ordinary `--out json=-` output is primarily point JSON. The parser can recover if a wrapper, fixture, future k6 mode, or deliberately added `handleSummary()` emits a JSON object containing `metrics`, but an ordinary missing summary file can legitimately leave only point-stream evidence. Do not document stdout fallback as equivalent to a valid summary export, and do not add `handleSummary()` casually: a custom handler changes k6 end-of-test output ownership and must be checked against the pinned runtime version. The simplest target adaptation is to keep the CLI summary file authoritative and keep stdout parsing as bounded opportunistic recovery.

### Exact parser vocabulary and summary-shape compatibility

`apps/load-orchestrator/src/k6-output-parser.ts::parseK6SummaryMetrics()` scans arbitrary text for balanced JSON objects, respecting quoted strings, escapes, and nested braces. It parses every object with a `metrics` object, discards objects with none of the supported values, and returns the **last** supported summary. Malformed text and point objects are ignored. This lets a retained stdout tail contain logs/points before an aggregate object without requiring the whole string to be one JSON document.

The reference supports these terminal metric names:

- Counters: `http_reqs`, `checkout_reservation_accepted`, `checkout_sold_out_rejections`, `checkout_unexpected_responses`, `iterations`, and `dropped_iterations`.
- Trends: `http_req_blocked`, `http_req_connecting`, `http_req_tls_handshaking`, `http_req_sending`, `http_req_waiting`, `http_req_receiving`, and `http_req_duration`.
- Rate: `http_req_failed`.

It deliberately accepts both observed k6 summary shapes:

```json
{
  "metrics": {
    "http_reqs": { "count": 1000, "rate": 998.2 },
    "http_req_duration": { "avg": 104.2, "p(95)": 112.3 },
    "http_req_failed": { "value": 0.5, "passes": 500, "fails": 500 }
  }
}
```

The flat shape above is the legacy `--summary-export` shape actually observed by the reference. It also accepts the wrapped end-of-test/`handleSummary(data)`-style shape:

```json
{
  "metrics": {
    "http_reqs": { "values": { "count": 1000 } },
    "http_req_duration": { "values": { "avg": 104.2, "p(95)": 112.3 } },
    "http_req_failed": { "values": { "rate": 0.5 } }
  }
}
```

Counter parsing first accepts a finite direct `metric.count`, then finite `metric.values.count`, and rounds the result. Trend/rate parsing uses `metric.values` when present and otherwise the metric object itself. A trend becomes `{ averageMs: finite avg or null, p95Ms: finite p(95) or null }` and is absent only when both values are unavailable. A rate reads finite `value` first, then `rate`. Missing metrics remain absent rather than becoming zero; zero is a valid observed value. Unknown metrics, nonobjects, nonfinite numbers, and unsupported keys are ignored without rejecting the rest of the summary.

Checkout Surge must adapt the donor names to the script vocabulary established by the preceding task: `checkout_reservation_accepted`, `checkout_sold_out`, and `checkout_unexpected_response`. Do not silently switch Surge to Forge's plural `checkout_sold_out_rejections` / `checkout_unexpected_responses` names unless the generated script, point parser, contracts, and all fixtures are migrated together. Support `iterations` and all six HTTP phase trends in addition to Surge's existing `http_reqs`, `http_req_duration`, `http_req_failed`, outcome counters, and `dropped_iterations`.

### Summary-first precedence, source annotation, and degraded fallback

Forge keeps `summaryMetrics` separate from `pointStreamAggregates`. Its `countWithSummaryPreference()` applies this exact precedence per counter:

1. If the summary contains a numeric counter, use it and mark the source `summary_export` (including an observed zero).
2. Otherwise, if the point aggregate exists, use its rounded value sum and mark the source `point_stream`.
3. Otherwise return a presentation count of zero, a semantic `countOrNull` of `null`, and no source.

The distinction between zero and unavailable is essential for `iterations`, `droppedIterations`, and delivery/accounting logic. Do not implement fallback with truthiness (`summaryCount || pointCount`), because that would discard authoritative zeros. Summary preference is per metric, not all-or-nothing: a partially understood/new summary shape may supply `http_reqs` while an outcome counter falls back to points.

The reference contract enum is exactly `summary_export | point_stream`. `terminalMetricSources` maps `totalAttempts`, `acceptedReservations`, `soldOutRejections`, `unexpectedResponses`, `observedRequests`, `droppedIterations`, and `completedIterations` independently. Outcome counters using point fallback add `k6_outcome_counter_point_stream_fallback_used`; unavailable outcome counters add `k6_outcome_counter_summary_export_unavailable`. File/parse warnings remain separate so operators can distinguish a damaged export from an individual missing metric.

For Surge, use its current field vocabulary and the richer delivery contract expected from task 40: annotate at least `emittedRequests`/`completedRequests`, `acceptedResponses`, `soldOutResponses`, `unexpectedResponses`, `droppedIterations`, and `completedIterations`. Put the typed source map and export warnings into the typed load-run diagnostics contract introduced by task 33; do not add an unvalidated parallel object or expose source metadata as dashboard live samples. If task 33 retained an extension-safe stored diagnostics envelope for reset/startup-recovery artifacts, add these fields only to the real-k6 completion variant so synthetic terminal summaries remain parseable.

HTTP summary mapping in Surge remains its public shape:

- `plannedRequests`: accepted execution-plan fact, never taken from k6 output.
- `emittedRequests` and `completedRequests`: summary `http_reqs`, else point total. Preserve the current equality unless a separately instrumented response-lifecycle metric exists; do not claim `iterations` is an HTTP completion count.
- `acceptedResponses`, `soldOutResponses`, `unexpectedResponses`: corresponding custom summary counter, else its point total.
- `failedRequests`: retain Surge's established domain formula (`max(unexpectedResponses, httpFailedRequests - soldOutResponses, 0)`), but derive the failure-rate input from summary `http_req_failed` first. A k6 Rate summary is a ratio, not a count; derive a count only with a documented rounding rule against observed requests if the typed contract still requires one.
- `p95LatencyMs`: summary `http_req_duration["p(95)"]` first. A rolling sum/count cannot reconstruct a percentile. If summary p95 is unavailable, the existing retained latency points may supply an exact fallback only while that bounded-memory tradeoff is deliberately retained; otherwise report the optional field as unavailable rather than inventing it from an average.
- `failureRate`: summary `http_req_failed.value/rate` first, else point-stream average/ratio using the current semantics.

Task 40 makes the API authoritative for delivery classification. This task supplies better raw `emittedRequests`, `iterations`, `droppedIterations`, outcome counts, and source evidence; it must not restore producer-owned quality thresholds or trust a k6 summary status.

### Full HTTP timing breakdown

Forge maps the six k6 phase trends as follows:

| k6 metric | terminal field | Meaning |
| --- | --- | --- |
| `http_req_blocked` | `blocked` | time waiting for a connection slot, including DNS where applicable |
| `http_req_connecting` | `connecting` | TCP connection establishment |
| `http_req_tls_handshaking` | `tlsHandshaking` | TLS negotiation |
| `http_req_sending` | `sending` | request upload |
| `http_req_waiting` | `waiting` | time to first response byte |
| `http_req_receiving` | `receiving` | response download |

Each field is `null` or `{ averageMs, p95Ms }`, where either numeric member may be null. The whole breakdown is null only when every phase is unavailable in Forge. Surge's completion contract currently requires a JSON object and emits only `{ p95LatencyMs }`; replace that placeholder with an explicit strict timing schema if prior ordered tasks have not already done so. If retaining a required object for storage compatibility, use the six named nullable fields rather than an unrelated top-level duration p95. `http_req_duration` belongs in `httpSummary` (`averageLatencyMs`/`p95LatencyMs` as supported by the current schema), not as a seventh phase.

For each phase, prefer the summary trend. If absent, point aggregates can compute `averageMs = valueSum / sampleCount`, but cannot reconstruct p95 unless raw values for that phase were intentionally retained. Report `{ averageMs, p95Ms: null }` for this degraded point fallback. This task should replace the unbounded `latencies: number[]` with bounded aggregation where possible; retaining every request duration for percentile fallback defeats the reason for using the terminal export on a 10k+ load run.

## Checkout-Surge implementation map

1. **Contracts (`packages/contracts/src/load.ts`)**: define/reuse strict types for summary metric source, per-field terminal source annotations, export warnings, and the six-phase timing breakdown. Coordinate with task 33's diagnostics contract and task 40's enriched delivery input. Keep legacy/synthetic stored diagnostic compatibility at the API/DB boundary; the actual orchestrator completion payload should be strict.
2. **Parser (`apps/load-orchestrator/src/application/k6-output-parser.ts`)**: separate live point parsing/aggregation from terminal summary parsing. Add explicit `K6SummaryMetrics` types and pure `parseK6SummaryMetrics()` with both flat and wrapped-shape readers, finite-number checks, missing-versus-zero preservation, arbitrary-text JSON-object extraction, and Surge's exact custom counter names. Keep malformed/unknown lines nonfatal.
3. **Accumulator/summary builder**: keep bounded rolling point totals/sums/timestamps as fallback evidence, not as the primary terminal source. Build each terminal field independently with summary-first precedence and source metadata. Do not let a missing export erase point evidence already observed, and do not let a partial export erase per-metric fallback.
4. **Runner (`apps/load-orchestrator/src/application/k6-runner.ts`)**: create `summary.json` in the existing per-run temp directory, spawn with `run --quiet --summary-export <path> --out json=- <script>`, retain only a bounded stdout tail while continuing line parsing, and read/parse the export after close but before building/sending completion or deleting the directory. Ensure error/close/cancellation still report or suppress completion exactly once according to the process-ownership work from task 33.
5. **Diagnostics**: record file missing/read/invalid warnings and per-terminal-field sources. Keep raw summary JSON and raw stdout out of the API report/logs; they can be large or contain diagnostic data. The completion retry must reuse one already-built immutable report rather than reread a now-deleted file or recompute different fallback results.
6. **Mandatory real-k6 lane**: keep ordinary host-native unit tests independent of a host k6 install, but add a dedicated `test:k6-compat` lane that fails immediately when k6 is absent. Run that lane inside the repository's `load-orchestrator-runtime` image, which copies pinned `grafana/k6:2.0.0` to `/usr/local/bin/k6`; do not make its success conditional on `resolveRunnableK6Binary()` or `it.skip`. Wire the lane into the required CI/merge command rather than leaving it as documentation. A suitable container command is `docker compose run --rm --no-deps load-orchestrator pnpm --filter load-orchestrator test:k6-compat` after building the target image; an equivalent dedicated Docker test target is acceptable.

Version drift matters: Forge's evidence came from a `grafana/k6:0.56.0` image, while Surge currently pins `grafana/k6:2.0.0`. Do not copy golden output wholesale across that gap. Pin the test lane to the same Docker stage as production, parse only the stable fields enumerated above, tolerate additional metric keys, and fail with a focused message if the required counter/trend/rate fields cannot be read from the runtime's actual export shape. A future k6 image bump must update the production binary and compatibility fixtures/lane in the same change.

## Focused fixture and real-k6 verification

No API, database, Redis, worker, browser, or full load run is needed. Add focused coverage at the load-orchestrator/contract boundary:

- Parser fixtures for the flat `--summary-export` shape and the wrapped `{ values: ... }` shape, including direct and wrapped counter counts, trend `avg`/`p(95)`, rate `value`/`rate`, authoritative zeros, partial metrics, unknown keys, nonfinite/wrong-typed values, malformed surrounding text, multiple JSON objects with the last supported summary winning, braces/escapes inside strings, and no-supported-metric `{}` output.
- Summary precedence fixtures where one metric comes from export, another from point stream, and a third is unavailable. Assert exact source annotations and prove an export zero beats a nonzero point fallback.
- Runner fixtures with a fake k6 child that writes a valid export, omits it, writes invalid JSON, and triggers a non-`ENOENT` read failure. Assert completion waits for the read, warnings are distinct, point fallback survives, report delivery occurs once, retry reuses the same object, and cleanup happens afterward. Cover bounded stdout retention without allocating an unbounded load fixture.
- Timing fixtures covering all six field mappings, summary avg/p95, point-average/null-p95 fallback, partial timing summaries, and an entirely unavailable breakdown.
- Contract/persistence fixtures proving the typed source/timing objects survive API completion ingestion and terminal-summary persistence, while reset/startup-reconciliation diagnostic objects from earlier tasks remain valid.
- In the mandatory container lane, run `k6 inspect` on generated buyer-spike and steady-arrival scripts. Also run a tiny no-external-service scenario (or a local loopback fixture owned by the test process) with `--summary-export`, parse the real file produced by the pinned `/usr/local/bin/k6`, and assert readable `http_reqs`, `iterations`, `http_req_duration`, and `http_req_failed` values. This is a compatibility smoke, not a benchmark; keep request count and timeout small.

## Scope and non-goals

This task owns the load-orchestrator's terminal k6 summary ingestion, bounded point fallback, source/timing diagnostics, and a mandatory real-k6 compatibility lane. It does not change executor/VU sizing or `gracefulStop` (task 43), reservation/buy classification semantics (task 41), API-owned delivery thresholds and durable accounting (task 40), cancellation/readiness/system-diagnostic ownership (task 33), live dashboard metric names, reservation/worker behavior, or hosted benchmark tuning. Do not add DB/Redis clients to the orchestrator, start application services in the compatibility test, expose raw k6 output publicly, or treat the real-k6 smoke as a performance assertion.
