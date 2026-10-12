import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadEnvironment, production, withEnvironmentNames } from "./environment.mjs";

const proof = loadEnvironment(fileURLToPath(new URL("proof.json", import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), "fly-environment-"));
// A flyctl stand-in: answers `auth token` and records every other call.
const flyctlCalls = join(directory, "flyctl-calls");
const flyctl = join(directory, "flyctl");
writeFileSync(
  flyctl,
  `#!/bin/sh\n[ "$*" = "auth token" ] && echo test-token && exit 0\necho "$*" >> ${flyctlCalls}\n`,
);
chmodSync(flyctl, 0o755);
// Answers every Machines API call with an app of organization `personal`, and records it.
const apiCalls = join(directory, "api-calls");
const fetchStandIn = join(directory, "fetch.mjs");
writeFileSync(
  fetchStandIn,
  `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, init) => {
  appendFileSync(${JSON.stringify(apiCalls)}, \`\${init.method} \${url}\\n\`);
  return new Response(JSON.stringify({ organization: { slug: "personal" } }));
};`,
);

function runScript(script, args) {
  return execFileSync(
    process.execPath,
    ["--import", fetchStandIn, fileURLToPath(new URL(script, import.meta.url)), ...args],
    { env: { ...process.env, FLYCTL: flyctl }, stdio: "pipe" },
  );
}

test("production stays the default, and the proof Machine configs name no production app", () => {
  assert.equal(loadEnvironment(), production);
  for (const file of ["core", "runner", "gate"].map((role) => `${role}/machine.json`)) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(withEnvironmentNames(text, production), text);
    assert.doesNotMatch(withEnvironmentNames(text, proof), /checkout-surge-/);
  }
  const guard = readFileSync(new URL("gate/guard-machine.json", import.meta.url), "utf8");
  assert.doesNotMatch(withEnvironmentNames(guard, proof), /checkout-surge-/);
});

test("a proof config naming a production app or another organization is refused", () => {
  const config = (overrides) => {
    const path = join(directory, `${Object.keys(overrides)[0]}.json`);
    writeFileSync(path, JSON.stringify({ ...proof, ...overrides }));
    return path;
  };
  const productionApp = config({ apps: { ...proof.apps, runner: production.apps.runner } });
  assert.throws(() => loadEnvironment(productionApp), /may not name a production app/);
  assert.throws(() => loadEnvironment(config({ organization: "personal" })), /playground-416/);
  assert.throws(
    () => runScript("deploy.mjs", ["all", "--environment", productionApp]),
    (error) => error.stderr.toString().includes("may not name a production app"),
  );
  assert.equal(existsSync(flyctlCalls) || existsSync(apiCalls), false);
});

test("deploy and destroy refuse proof apps outside the proof organization before any change", () => {
  const proofPath = fileURLToPath(new URL("proof.json", import.meta.url));
  for (const args of [
    ["deploy.mjs", "all", "--environment", proofPath],
    ["proof.mjs", "destroy"],
  ]) {
    assert.throws(
      () => runScript(args[0], args.slice(1)),
      (error) =>
        error.stderr.toString().includes("is not in organization playground-416; refused."),
    );
  }
  assert.equal(existsSync(flyctlCalls), false);
  const appReads = Object.values(proof.apps).map(
    (app) => `GET https://api.machines.dev/v1/apps/${app}`,
  );
  for (const call of readFileSync(apiCalls, "utf8").trim().split("\n")) {
    assert.ok(appReads.includes(call), call);
  }
});
