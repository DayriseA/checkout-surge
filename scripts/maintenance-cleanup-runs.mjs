#!/usr/bin/env node

import { parseArgs } from "node:util";

const apiBaseUrl = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const token = process.env.CONTROL_SERVICE_TOKEN?.trim();

if (!token) {
  console.error("CONTROL_SERVICE_TOKEN is required for generated-run cleanup.");
  process.exit(1);
}

const {
  values: { "keep-latest": keepLatest, "older-than-days": olderThanDays },
} = parseArgs({
  args: process.argv.slice(2),
  options: {
    "keep-latest": { type: "string" },
    "older-than-days": { type: "string" },
  },
});
const options = {
  ...(keepLatest === undefined ? {} : { keepLatest: Number(keepLatest) }),
  ...(olderThanDays === undefined ? {} : { olderThanDays: Number(olderThanDays) }),
};
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
