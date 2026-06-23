#!/usr/bin/env node

const apiBaseUrl = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const token = process.env.CONTROL_SERVICE_TOKEN?.trim();

if (!token) {
  console.error("CONTROL_SERVICE_TOKEN is required for generated-run cleanup.");
  process.exit(1);
}

const options = parseArgs(process.argv.slice(2));
const response = await fetch(`${apiBaseUrl}/admin/demo/runs/cleanup`, {
  method: "POST",
  headers: {
    accept: "application/json",
    "content-type": "application/json",
    "x-control-service-token": token,
  },
  body: JSON.stringify(options),
});
const payload = await response.json().catch(() => null);

if (!response.ok) {
  console.error(`Generated-run cleanup failed with HTTP ${response.status}.`);
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(payload, null, 2));

function parseArgs(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--keep-latest" && next) {
      parsed.keepLatest = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--older-than-days" && next) {
      parsed.olderThanDays = Number(next);
      index += 1;
      continue;
    }

    throw new Error(`Unsupported cleanup argument: ${arg}`);
  }

  return parsed;
}
