import {
  buyOutcomeHeaderName,
  deriveLoadExecutionPlan,
  type LoadExecutionPlan,
  loadRunIdHeaderName,
  type SteadyArrivalTrafficConfig,
  type TrafficExecutionStartRequest,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName } from "@checkout-surge/logger";

export interface GeneratedK6Script {
  contents: string;
  plannedRequests: number;
  executionPlan: LoadExecutionPlan;
}

export const k6ScenarioGracefulStop = "30s";

export function resolveSteadyArrivalExecutionPlan(
  traffic: SteadyArrivalTrafficConfig,
): Extract<LoadExecutionPlan, { trafficMode: "steady-arrival-rate" }> {
  return deriveLoadExecutionPlan(traffic) as Extract<
    LoadExecutionPlan,
    { trafficMode: "steady-arrival-rate" }
  >;
}

export function generateK6Script(input: TrafficExecutionStartRequest): GeneratedK6Script {
  const traffic = input.configSnapshot.trafficConfig;
  const executionPlan = deriveLoadExecutionPlan(traffic);
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
const attemptsStarted = new Counter("checkout_attempts_started");
const responsesCompleted = new Counter("checkout_responses_completed");
const acceptedResponses = new Counter("checkout_reservation_accepted");
const soldOutResponses = new Counter("checkout_sold_out_rejections");
const transportFailures = new Counter("checkout_transport_failures");
const unexpectedResponses = new Counter("checkout_unexpected_responses");
const checkoutOutcomeHeaderName = "${buyOutcomeHeaderName}";

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
  attemptsStarted.add(1);
  const response = http.post(
    \`\${config.apiBaseUrl}/buy\`,
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
  responsesCompleted.add(1);

  const outcome = readResponseHeader(response, checkoutOutcomeHeaderName);
  const isAccepted =
    response.status === 202 &&
    (outcome === "reservation_secured" ||
      outcome === "reservation_pending_persistence");
  const isSoldOut = response.status === 409 && outcome === "sold_out";

  if (response.status === 0) {
    transportFailures.add(1);
  } else if (isAccepted) {
    acceptedResponses.add(1);
  } else if (isSoldOut) {
    soldOutResponses.add(1);
  } else {
    unexpectedResponses.add(1);
  }

  // Transport failures still fail this k6-facing check because no expected
  // checkout response was received.
  check(response, {
    "expected checkout response": () => isAccepted || isSoldOut,
  });
}
`,
  };
}
