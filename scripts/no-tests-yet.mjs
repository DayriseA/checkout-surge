#!/usr/bin/env node

const [scope = "test", message = "No tests are defined for this scope yet."] =
  process.argv.slice(2);

console.log(`${scope}: ${message}`);
