import type { TrafficExecutionStartRequest } from "@checkout-surge/contracts";

export interface GeneratedK6Script {
  contents: string;
  plannedRequests: number;
}

export function generateK6Script(input: TrafficExecutionStartRequest): GeneratedK6Script {
  const traffic = input.configSnapshot.trafficConfig;
  const plannedRequests =
    traffic.mode === "buyer-spike"
      ? traffic.buyerCount * (traffic.duplicateEachBuyerAttempt ? 2 : 1)
      : traffic.ratePerSecond * traffic.durationSeconds;
  const scenario =
    traffic.mode === "buyer-spike"
      ? {
          executor: "per-vu-iterations",
          vus: traffic.buyerCount,
          iterations: traffic.duplicateEachBuyerAttempt ? 2 : 1,
          startTime: `${traffic.startDelaySeconds}s`,
          maxDuration: `${traffic.maxDurationSeconds}s`,
        }
      : {
          executor: "constant-arrival-rate",
          rate: traffic.ratePerSecond,
          timeUnit: "1s",
          duration: `${traffic.durationSeconds}s`,
          startTime: `${traffic.startDelaySeconds}s`,
          preAllocatedVUs:
            traffic.k6Vus?.preAllocatedVus ?? Math.max(1, Math.ceil(traffic.ratePerSecond / 2)),
          maxVUs: traffic.k6Vus?.maxVus ?? Math.max(1, traffic.ratePerSecond * 2),
        };
  const scriptConfig = {
    runId: input.runId,
    saleOfferId: input.saleOfferId,
    apiBaseUrl: input.apiBaseUrl.replace(/\/+$/, ""),
    buyEndpointPath: input.buyEndpointPath,
    correlationId: input.correlationId,
    quantity: input.configSnapshot.inventoryConfig.quantityPerCheckout,
    duplicateEachBuyerAttempt:
      input.configSnapshot.trafficConfig.mode === "buyer-spike" &&
      input.configSnapshot.trafficConfig.duplicateEachBuyerAttempt,
  };

  return {
    plannedRequests,
    contents: `import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import { Counter } from "k6/metrics";

const config = ${JSON.stringify(scriptConfig)};
const acceptedResponses = new Counter("checkout_reservation_accepted");
const soldOutResponses = new Counter("checkout_sold_out");
const unexpectedResponses = new Counter("checkout_unexpected_response");

export const options = ${JSON.stringify({ scenarios: { checkout: scenario } })};

export default function () {
  const iteration = exec.scenario.iterationInTest;
  const buyerId = config.duplicateEachBuyerAttempt ? __VU : iteration;
  const idempotencyKey = config.duplicateEachBuyerAttempt
    ? \`run:\${config.runId}:buyer:\${buyerId}\`
    : \`run:\${config.runId}:attempt:\${iteration}\`;
  const response = http.post(
    \`\${config.apiBaseUrl}\${config.buyEndpointPath}\`,
    JSON.stringify({
      saleOfferId: config.saleOfferId,
      runId: config.runId,
      idempotencyKey,
      quantity: config.quantity,
      correlationId: \`\${config.correlationId}:k6:\${iteration}\`,
    }),
    { headers: { "content-type": "application/json", accept: "application/json" } },
  );

  let outcome = null;
  try {
    outcome = response.json("outcome");
  } catch (_) {
    outcome = null;
  }

  if (response.status === 202) {
    acceptedResponses.add(1);
  } else if (response.status === 409 && outcome === "sold_out") {
    soldOutResponses.add(1);
  } else {
    unexpectedResponses.add(1);
  }

  check(response, {
    "expected checkout response": (result) =>
      result.status === 202 || (result.status === 409 && outcome === "sold_out"),
  });
}
`,
  };
}
