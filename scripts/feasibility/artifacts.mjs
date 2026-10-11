import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, readdirSync, readSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const path = resolve(process.argv[3] ?? "/results");
if (!path.startsWith("/results/") || !/^\/results\/[a-zA-Z0-9/_.-]+$/.test(path))
  throw new Error("Only lab result files can be exported.");
const checksum = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
let result;
if (process.argv[2] === "manifest") {
  const files = [];
  const visit = async (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const target = resolve(directory, item.name);
      if (item.isSymbolicLink()) throw new Error("Symbolic links are forbidden in result exports.");
      if (item.isDirectory()) await visit(target);
      else
        files.push({
          path: relative(path, target),
          bytes: statSync(target).size,
          sha256: await checksum(target),
        });
    }
  };
  await visit(path);
  result = { files };
} else if (process.argv[2] === "chunk") {
  const offset = Number(process.argv[4]);
  const size = Number(process.argv[5]);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 49152
  )
    throw new Error("Invalid bounded artifact chunk.");
  const buffer = Buffer.alloc(size);
  const descriptor = openSync(path, "r");
  try {
    const count = readSync(descriptor, buffer, 0, size, offset);
    result = { offset, data: buffer.subarray(0, count).toString("base64") };
  } finally {
    closeSync(descriptor);
  }
} else throw new Error("Expected manifest or chunk.");
console.log(`LAB_ARTIFACT ${JSON.stringify(result)}`);
