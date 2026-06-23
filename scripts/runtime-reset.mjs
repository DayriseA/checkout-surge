#!/usr/bin/env node

const apiBaseUrl = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const token = process.env.CONTROL_SERVICE_TOKEN?.trim();

if (!token) {
  console.error("CONTROL_SERVICE_TOKEN is required for runtime reset.");
  process.exit(1);
}

const response = await fetch(`${apiBaseUrl}/admin/demo/reset`, {
  method: "POST",
  headers: {
    accept: "application/json",
    "x-control-service-token": token,
  },
});
const payload = await response.json().catch(() => null);

if (!response.ok) {
  console.error(`Runtime reset failed with HTTP ${response.status}.`);
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(payload, null, 2));
