export function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

export function optionalIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim();
  const parsed = Number(normalized);

  if (normalized.length === 0 || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer when provided.`);
  }

  return parsed;
}

export function optionalNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim();
  const parsed = Number(normalized);

  if (normalized.length === 0 || !Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number when provided.`);
  }

  return parsed;
}
