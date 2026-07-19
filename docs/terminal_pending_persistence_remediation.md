# Terminal Pending-Persistence Remediation

This one-time workflow repairs the 98 pending Redis records found on the two audited terminal runs from Issue 04. It is deliberately targeted to those run/sale pairs and is not a general key-deletion utility.

Deploy the corrected application build with the API stopped. Keep PostgreSQL and Redis available, and do not start the API lifecycle poller until the retained dry-run and apply reports have been reviewed. The required order is: stop API, deploy corrected code, run and retain dry-run, run and retain apply, rerun and retain the clean dry-run, then start the corrected API. This prevents background reconciliation from changing the evidence between inspection and apply.

Run the default dry-run first:

```sh
pnpm maintenance:remediate-terminal-pending
```

The command inspects at most 1,000 records per target and refuses to scan a global pending index above its separate 10,000-member bound. Before mutation it verifies the terminal PostgreSQL run and generated sale ownership, parses and cross-checks each Redis pending record and hold, requires every parsed record's exact namespaced global member, rejects every extra global member for the target sale, validates the matching idempotency record when one is present, and looks up the exact reservation/order evidence. Its bounded JSON report contains run, sale, reservation ID, disposition, reason, and aggregate structure counts; it omits correlation IDs, idempotency keys, reservation tokens, and payload bodies.

The only safe dispositions are:

- `durable`: an exactly matching PostgreSQL reservation and order exist, so apply reasserts the deterministic BullMQ job, marks reconciliation, and atomically promotes/cleans Redis;
- `reverse`: the target run is terminal, owns the sale, and no durable buy exists, so apply marks reconciliation and atomically reverses the Redis hold.

An absent idempotency record is safe for either disposition because the production Lua scripts remain authoritative: promotion recreates the exact accepted record from the validated hold, while reversal removes the hold without inventing an outcome. A present record must have a positive TTL and exactly match quantity plus every reservation identity field. `pending_persistence` is safe for either disposition; `accepted` is safe only for a durable promotion cleanup. Malformed, mismatched, expired/persistent, or disposition-conflicting idempotency evidence is unsafe.

Malformed/missing Redis companions, missing or extra target-sale global members, a nonterminal or mismatched run/sale, an attribution-mismatched durable row, or either structure count above its bound produces `unsafe` and blocks all apply work.

After reviewing and retaining the dry-run report, apply explicitly:

```sh
pnpm maintenance:remediate-terminal-pending -- --apply
```

Apply performs a fresh inspection, processes bounded 100-record pages through the production reconciler, and fails on any retryable record. It then performs another bounded full global-index read and verifies that the target sale's pending ZSET and pending-record hash are empty and that no target-sale global member remains, including one not present during inspection. Rerun the dry-run after any failure before retrying apply. A completed repeat is a no-op because deterministic order job IDs, durable uniqueness, and atomic Redis cleanup make the workflow idempotent.

Do not substitute `DEL`, `UNLINK`, or manual key removal. Do not run apply against an unreviewed environment, and retain both dry-run and apply JSON as the operational audit record. The command does not print connection strings or buyer-sensitive values.
