// Polls PostgreSQL every second and prints, per run, when its last reservation was secured
// and its last order confirmed. Teardown deletes the rows, so the last line per run is kept.
import { createRequire } from "node:module";

const postgres = createRequire(new URL("../packages/db/package.json", import.meta.url))("postgres");

const sql = postgres(process.argv[2] ?? "postgresql://postgres:postgres@127.0.0.1:5432/checkout_surge", { max: 1 });
const last = new Map();
for (;;) {
  const rows = await sql`
    select o.run_id as "runId", count(*)::int as orders,
      count(*) filter (where o.status = 'confirmed')::int as confirmed,
      max(r.secured_at) as "lastSecuredAt", max(o.confirmed_at) as "lastConfirmedAt"
    from orders o join reservations r on r.id = o.reservation_id group by o.run_id`;
  for (const row of rows) {
    const line = JSON.stringify(row);
    if (last.get(row.runId) !== line) {
      last.set(row.runId, line);
      console.log(JSON.stringify({ observedAt: new Date(), ...row }));
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
}
