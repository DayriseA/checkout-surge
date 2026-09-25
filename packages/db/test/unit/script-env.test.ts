import { afterEach, describe, expect, it, vi } from "vitest";
import { optionalIntegerEnv, optionalNumberEnv } from "../../src/scripts/env.js";

const variableName = "CHECKOUT_SURGE_SCRIPT_ENV_TEST";

describe("script environment parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { parse: optionalIntegerEnv, value: "10oops", message: "must be an integer when provided." },
    { parse: optionalIntegerEnv, value: "", message: "must be an integer when provided." },
    { parse: optionalNumberEnv, value: "   ", message: "must be a number when provided." },
  ])("rejects $value from $parse.name", ({ parse, value, message }) => {
    vi.stubEnv(variableName, value);

    expect(() => parse(variableName, 1)).toThrow(`${variableName} ${message}`);
  });
});
