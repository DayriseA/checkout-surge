import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: direct lab runtime, outside Turborepo caching.
if (process.env.FEASIBILITY_LAB !== "true")
  throw new Error("Only the feasibility lab can run the observer.");
createServer(async (request, response) => {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: direct lab runtime, outside Turborepo caching.
  if (request.headers["x-lab-token"] !== process.env.LAB_TOKEN) {
    response.writeHead(401);
    response.end();
    return;
  }
  const cpu = {};
  for (const role of ["postgres", "redis"]) {
    try {
      cpu[role] = JSON.parse(await readFile(`/persistent/cpu/${role}.json`, "utf8"));
    } catch {
      cpu[role] = null;
    }
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ observedAt: new Date().toISOString(), cpu }));
}).listen(4501, "::");
