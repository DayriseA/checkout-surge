import {
  buyOutcomeHeaderName,
  buyRejectionReasonHeaderName,
  calculatePlannedRequests,
  type LoadExecutionPlan,
  loadRunIdHeaderName,
  resolveSteadyArrivalVus,
  type SteadyArrivalTrafficConfig,
  type TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName } from "@checkout-surge/logger";

export interface GeneratedK6Script {
  contents: string;
  plannedRequests: number;
  executionPlan: LoadExecutionPlan;
}

export const k6ScenarioGracefulStop = "5s";

export function resolveSteadyArrivalExecutionPlan(
  traffic: SteadyArrivalTrafficConfig,
): Extract<LoadExecutionPlan, { trafficMode: "steady-arrival-rate" }> {
  return {
    trafficMode: traffic.mode,
    ratePerSecond: traffic.ratePerSecond,
    durationSeconds: traffic.durationSeconds,
    plannedEmittedAttempts: calculatePlannedRequests(traffic),
    startDelaySeconds: traffic.startDelaySeconds,
    ...resolveSteadyArrivalVus(traffic),
  };
}

export function generateK6Script(input: TrafficExecutionStartRequest): GeneratedK6Script {
  const traffic = input.configSnapshot.trafficConfig;
  const executionPlan: LoadExecutionPlan =
    traffic.mode === "buyer-spike"
      ? {
          trafficMode: traffic.mode,
          buyerCount: traffic.buyerCount,
          duplicateEachBuyerAttempt: traffic.duplicateEachBuyerAttempt,
          iterationsPerVu: traffic.duplicateEachBuyerAttempt ? 2 : 1,
          plannedEmittedAttempts: calculatePlannedRequests(traffic),
          startDelaySeconds: traffic.startDelaySeconds,
          maxDurationSeconds: traffic.maxDurationSeconds,
        }
      : resolveSteadyArrivalExecutionPlan(traffic);
  const plannedRequests = executionPlan.plannedEmittedAttempts;
  const scenario =
    executionPlan.trafficMode === "buyer-spike"
      ? {
          executor: "per-vu-iterations",
          vus: executionPlan.buyerCount,
          iterations: executionPlan.iterationsPerVu,
          startTime: `${executionPlan.startDelaySeconds}s`,
          maxDuration: `${executionPlan.maxDurationSeconds}s`,
          gracefulStop: k6ScenarioGracefulStop,
        }
      : {
          executor: "constant-arrival-rate",
          rate: executionPlan.ratePerSecond,
          timeUnit: "1s",
          duration: `${executionPlan.durationSeconds}s`,
          startTime: `${executionPlan.startDelaySeconds}s`,
          preAllocatedVUs: executionPlan.preAllocatedVus,
          maxVUs: executionPlan.maxVus,
          gracefulStop: k6ScenarioGracefulStop,
        };
  const scriptConfig = {
    runId: input.runId,
    saleOfferId: input.saleOfferId,
    apiBaseUrl: input.apiBaseUrl.replace(/\/+$/, ""),
    buyEndpointPath: input.buyEndpointPath,
    correlationId: input.correlationId,
    quantity: traffic.quantityPerAttempt,
    plannedRequests,
    trafficMode: traffic.mode,
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
const soldOutResponses = new Counter("checkout_sold_out_rejections");
const unexpectedResponses = new Counter("checkout_unexpected_responses");
const checkoutOutcomeHeaderName = "${buyOutcomeHeaderName}";
const checkoutRejectionReasonHeaderName = "${buyRejectionReasonHeaderName}";

export const options = ${JSON.stringify({ discardResponseBodies: true, scenarios: { checkout: scenario } })};

function readResponseHeader(response, headerName) {
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === headerName) {
      return value;
    }
  }
  return null;
}

export default function () {
  const iteration = exec.scenario.iterationInTest;
  if (config.trafficMode === "steady-arrival-rate" && iteration >= config.plannedRequests) {
    return;
  }

  const buyerId = config.duplicateEachBuyerAttempt ? __VU : iteration;
  const idempotencyKey = config.duplicateEachBuyerAttempt
    ? \`run:\${config.runId}:buyer:\${buyerId}\`
    : \`run:\${config.runId}:attempt:\${iteration}\`;
  const correlationId = \`\${config.correlationId}:k6:\${iteration}\`;
  const response = http.post(
    \`\${config.apiBaseUrl}\${config.buyEndpointPath}\`,
    JSON.stringify({
      saleOfferId: config.saleOfferId,
      runId: config.runId,
      idempotencyKey,
      quantity: config.quantity,
      correlationId,
    }),
    {
      responseCallback: expectedCheckoutStatuses,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "${correlationIdHeaderName}": correlationId,
        "${loadRunIdHeaderName}": config.runId,
      },
    },
  );

  const outcome = readResponseHeader(response, checkoutOutcomeHeaderName);
  const rejectionReason = readResponseHeader(response, checkoutRejectionReasonHeaderName);
  const isAccepted =
    response.status === 202 &&
    (outcome === "reservation_secured" ||
      outcome === "idempotent_replay" ||
      outcome === "reservation_pending_persistence");
  const isSoldOut =
    response.status === 409 && outcome === "sold_out" && rejectionReason === "sold_out";

  if (isAccepted) {
    acceptedResponses.add(1);
  } else if (isSoldOut) {
    soldOutResponses.add(1);
  } else {
    unexpectedResponses.add(1);
  }

  check(response, {
    "expected checkout response": () => isAccepted || isSoldOut,
  });
}
`,
  };
}
