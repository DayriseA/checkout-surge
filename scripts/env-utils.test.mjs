import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mergeEnvFiles } from "./env-utils.mjs";

test("merges env files in order before applying the base environment", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "checkout-surge-env-"));
  const first = path.join(directory, ".env");
  const second = path.join(directory, ".env.local");

  try {
    writeFileSync(first, "FIRST=from-file\nSHARED=first\n");
    writeFileSync(second, "SHARED=second\nSECOND=from-local\n");

    assert.deepEqual(mergeEnvFiles([first, second], { SHARED: "from-shell" }), {
      FIRST: "from-file",
      SHARED: "from-shell",
      SECOND: "from-local",
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("uses Node dotenv comment and quoted-value semantics", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "checkout-surge-env-"));
  const envFile = path.join(directory, ".env");

  try {
    writeFileSync(
      envFile,
      'UNQUOTED=value#comment\nQUOTED="value#preserved"\nMULTILINE="first\nsecond"\n',
    );

    assert.deepEqual(mergeEnvFiles([envFile], {}), {
      UNQUOTED: "value",
      QUOTED: "value#preserved",
      MULTILINE: "first\nsecond",
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
});
