// Waits for a run to be terminal, then tears it down. Usage: node teardown-run.mjs <runId>
const base = process.env.API_BASE_URL ?? "http://127.0.0.1:4000";
const headers = { "x-control-service-token": process.env.CONTROL_SERVICE_TOKEN };
const runId = process.argv[2];
for (let i = 0; i < 120; i++) {
  const res = await fetch(`${base}/admin/demo/runs/${runId}`, { method: "DELETE", headers });
  const body = await res.json().catch(() => null);
  console.log(res.status, JSON.stringify(body?.outcome ?? body?.code ?? null));
  if (res.status === 200) break;
  await new Promise((r) => setTimeout(r, 5000));
}
