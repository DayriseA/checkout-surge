#!/usr/bin/env node
import { buildTestEnv, runCommand } from "./env-utils.mjs";
import { assertSafeTestEnvironment } from "./test-environment-safety.mjs";

const env = buildTestEnv();
assertSafeTestEnvironment(env);
runCommand(process.argv.slice(2), env);
