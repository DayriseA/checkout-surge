#!/usr/bin/env node

import { RuntimeResetAggregateError, resetRuntime } from "./runtime-reset-client.mjs";

try {
  const result = await resetRuntime();
  printResult(result);
} catch (error) {
  if (error instanceof RuntimeResetAggregateError) printResult(error.result);
  else console.error(error instanceof Error ? error.message : "Runtime reset failed.");
  process.exitCode = 1;
}

function printResult(result) {
  console.log(`Runtime reset correlation: ${result.correlationId}`);
  for (const service of result.services) {
    const status = service.status ? ` (HTTP ${service.status})` : "";
    const detail = service.message ? `: ${service.message}` : "";
    console.log(`${service.service}: ${service.outcome}${status}${detail}`);
  }
}
