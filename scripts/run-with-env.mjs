#!/usr/bin/env node
import { buildRuntimeEnv, runCommand } from "./env-utils.mjs";

runCommand(process.argv.slice(2), buildRuntimeEnv());
