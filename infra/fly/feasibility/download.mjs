import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppRequest, verifyApps } from "../environment.mjs";
import { loadLab } from "./lab.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const lab = loadLab(resolve(process.argv[2] ?? "infra/fly/feasibility/lab.json"));
const machine = process.argv[3];
const remote = process.argv[4];
const destination = resolve(process.argv[5] ?? ".tmp/feasibility-results");
if (
  !/^[a-z0-9]+$/.test(machine ?? "") ||
  !/^\/results\/[a-zA-Z0-9/_-]+$/.test(remote ?? "") ||
  !destination.startsWith(resolve(root) + sep)
)
  throw new Error(
    "Configure a runner Machine, /results directory and workspace-local destination.",
  );
// biome-ignore lint/suspicious/noUndeclaredEnvVars: direct operator script, outside Turborepo caching.
const flyctl = process.env.FLYCTL ?? "flyctl";
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
await verifyApps(lab, createAppRequest(run, flyctl));
const execute = (args) => {
  const output = run(flyctl, [
    "machine",
    "exec",
    machine,
    "--app",
    lab.apps.runner,
    `node /lab/scripts/feasibility/artifacts.mjs ${args.join(" ")}`,
  ]);
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith("LAB_ARTIFACT "));
  if (lines.length !== 1 || /Exit code: [1-9]/.test(output))
    throw new Error("Guest artifact export did not report validated success.");
  return JSON.parse(lines[0].slice("LAB_ARTIFACT ".length));
};
const { files } = execute(["manifest", remote]);
if (!files.some((file) => file.path === "records.json"))
  throw new Error("Matrix has no completed records file.");
for (const file of files) {
  if (!/^[a-zA-Z0-9/_.-]+$/.test(file.path) || file.path.split("/").includes(".."))
    throw new Error("Unsafe artifact path.");
  const local = resolve(destination, file.path);
  if (!local.startsWith(destination + sep)) throw new Error("Artifact escaped destination.");
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, Buffer.alloc(0));
  const hash = createHash("sha256");
  for (let offset = 0; offset < file.bytes; offset += 49152) {
    const chunk = execute([
      "chunk",
      `${remote}/${file.path}`,
      String(offset),
      String(Math.min(49152, file.bytes - offset)),
    ]);
    const data = Buffer.from(chunk.data, "base64");
    if (chunk.offset !== offset || data.length !== Math.min(49152, file.bytes - offset))
      throw new Error("Incomplete artifact chunk.");
    hash.update(data);
    appendFileSync(local, data);
  }
  if (hash.digest("hex") !== file.sha256)
    throw new Error(`Artifact checksum mismatch: ${file.path}`);
}
const completions = files.filter((entry) => entry.path.endsWith("/complete.json"));
const records = JSON.parse(readFileSync(resolve(destination, "records.json"), "utf8"));
if (completions.length !== records.length) throw new Error("Incomplete matrix run manifests.");
for (const file of completions) {
  const completion = JSON.parse(readFileSync(resolve(destination, file.path), "utf8"));
  const folder = file.path.slice(0, -"complete.json".length);
  for (const [name, checksum] of Object.entries(completion.files)) {
    if (!files.some((entry) => entry.path === folder + name && entry.sha256 === checksum))
      throw new Error("Run completion manifest is incomplete.");
  }
}
console.log(`Downloaded and verified ${files.length} artifact files.`);
