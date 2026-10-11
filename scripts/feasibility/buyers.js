import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";

const run = JSON.parse(__ENV.LAB_RUN_JSON);
const traffic = run.snapshot.trafficConfig;
const started = new Counter("buyer_started");
const completed = new Trend("buyer_result", true);
const cappedIterations = new Counter("buyer_capped_iterations");
const tags = { runId: run.runId, mode: run.mode };
export const options = {
  scenarios: {
    buyers:
      traffic.mode === "buyer-spike"
        ? {
            executor: "per-vu-iterations",
            vus: traffic.buyerCount,
            iterations: 1,
            maxDuration: `${traffic.maxDurationSeconds}s`,
            gracefulStop: "10s",
          }
        : {
            executor: "constant-arrival-rate",
            rate: traffic.ratePerSecond,
            timeUnit: "1s",
            duration: `${traffic.durationSeconds}s`,
            preAllocatedVUs: traffic.k6Vus.preAllocatedVus,
            maxVUs: traffic.k6Vus.maxVus,
            gracefulStop: "70s",
          },
  },
  discardResponseBodies: false,
};

export default function () {
  if (
    traffic.mode === "constant-arrival-rate" &&
    exec.scenario.iterationInTest >= traffic.ratePerSecond * traffic.durationSeconds
  ) {
    cappedIterations.add(1, tags);
    return;
  }
  const attempt = `${__VU}-${__ITER}`;
  started.add(1, { ...tags, attempt });
  const response = http.post(
    `${__ENV.LAB_CORE_URL}/buy`,
    JSON.stringify({
      runId: run.runId,
      saleOfferId: run.saleOfferId,
      quantity: 1,
      idempotencyKey: `${run.runId}-${attempt}`,
    }),
    {
      headers: {
        "content-type": "application/json",
        "x-lab-token": __ENV.LAB_TOKEN,
        "x-load-run-id": run.runId,
      },
      timeout: "65s",
      tags,
    },
  );
  let outcome = "transport_or_protocol_failure";
  try {
    outcome = response.json("outcome") ?? outcome;
  } catch {}
  completed.add(response.timings.duration, {
    ...tags,
    attempt,
    outcome,
    status: String(response.status),
  });
}
