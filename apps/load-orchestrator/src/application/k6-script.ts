import {
  type LoadExecutionPlan,
  loadRunIdHeaderName,
  type TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";

export interface GeneratedK6Script {
  contents: string;
  plannedRequests: number;
  executionPlan: LoadExecutionPlan;
}

export function generateK6Script(input: TrafficExecutionStartRequest): GeneratedK6Script {
  const traffic = input.configSnapshot.trafficConfig;
  const plannedRequests =
    traffic.mode === "buyer-spike"
      ? traffic.buyerCount * (traffic.duplicateEachBuyerAttempt ? 2 : 1)
      : traffic.ratePerSecond * traffic.durationSeconds;
  const executionPlan: LoadExecutionPlan =
    traffic.mode === "buyer-spike"
      ? {
          trafficMode: traffic.mode,
          buyerCount: traffic.buyerCount,
          duplicateEachBuyerAttempt: traffic.duplicateEachBuyerAttempt,
          iterationsPerVu: traffic.duplicateEachBuyerAttempt ? 2 : 1,
          plannedEmittedAttempts: plannedRequests,
          startDelaySeconds: traffic.startDelaySeconds,
          maxDurationSeconds: traffic.maxDurationSeconds,
        }
      : {
          trafficMode: traffic.mode,
          ratePerSecond: traffic.ratePerSecond,
          durationSeconds: traffic.durationSeconds,
          plannedEmittedAttempts: plannedRequests,
          startDelaySeconds: traffic.startDelaySeconds,
          preAllocatedVus:
            traffic.k6Vus?.preAllocatedVus ?? Math.max(1, Math.ceil(traffic.ratePerSecond / 2)),
          maxVus: traffic.k6Vus?.maxVus ?? Math.max(1, traffic.ratePerSecond * 2),
        };
  const scenario =
    executionPlan.trafficMode === "buyer-spike"
      ? {
          executor: "per-vu-iterations",
          vus: executionPlan.buyerCount,
          iterations: executionPlan.iterationsPerVu,
          startTime: `${executionPlan.startDelaySeconds}s`,
          maxDuration: `${executionPlan.maxDurationSeconds}s`,
        }
      : {
          executor: "constant-arrival-rate",
          rate: executionPlan.ratePerSecond,
          timeUnit: "1s",
          duration: `${executionPlan.durationSeconds}s`,
          startTime: `${executionPlan.startDelaySeconds}s`,
          preAllocatedVUs: executionPlan.preAllocatedVus,
          maxVUs: executionPlan.maxVus,
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
    executionPlan,
    contents: `import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import { Counter } from "k6/metrics";

const config = ${JSON.stringify(scriptConfig)};
const expectedCheckoutStatuses = http.expectedStatuses(202, 409);
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
    {
      responseCallback: expectedCheckoutStatuses,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "${loadRunIdHeaderName}": config.runId,
      },
    },
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
