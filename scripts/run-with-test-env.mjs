#!/usr/bin/env node
import { buildTestEnv, runCommand } from "./env-utils.mjs";

runCommand(process.argv.slice(2), buildTestEnv());
