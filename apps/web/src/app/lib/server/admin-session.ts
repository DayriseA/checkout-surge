import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const defaultAdminSessionMaxAgeSeconds = 8 * 60 * 60;

export function verifyAdminPassphrase(candidate: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

export function createAdminSessionToken(options: {
  secret: string;
  nowSeconds: number;
  maxAgeSeconds: number;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      iat: options.nowSeconds,
      exp: options.nowSeconds + options.maxAgeSeconds,
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload, options.secret)}`;
}

export function isValidAdminSessionToken(options: {
  token: string;
  secret: string;
  nowSeconds: number;
  maxAgeSeconds: number;
}): boolean {
  try {
    if (
      !Number.isSafeInteger(options.nowSeconds) ||
      !Number.isSafeInteger(options.maxAgeSeconds) ||
      options.nowSeconds < 0 ||
      options.maxAgeSeconds <= 0
    ) {
      return false;
    }
    const segments = options.token.split(".");
    if (segments.length !== 2) return false;
    const [payload, signature] = segments;
    if (
      !payload ||
      !signature ||
      !/^[A-Za-z0-9_-]+$/.test(payload) ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
      !safeSignatureEqual(signature, sign(payload, options.secret))
    ) {
      return false;
    }
    const payloadBytes = Buffer.from(payload, "base64url");
    if (payloadBytes.toString("base64url") !== payload) return false;
    const decoded = JSON.parse(payloadBytes.toString("utf8")) as unknown;
    if (!isSessionPayload(decoded)) return false;
    return (
      decoded.v === 1 &&
      decoded.iat <= options.nowSeconds &&
      decoded.exp > options.nowSeconds &&
      decoded.exp - decoded.iat === options.maxAgeSeconds
    );
  } catch {
    return false;
  }
}

export function parseAdminSessionMaxAge(raw: string | undefined): number | null {
  if (raw === undefined) return defaultAdminSessionMaxAgeSeconds;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeSignatureEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function isSessionPayload(value: unknown): value is { v: number; iat: number; exp: number } {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(payload.v) &&
    Number.isSafeInteger(payload.iat) &&
    Number.isSafeInteger(payload.exp) &&
    (payload.iat as number) >= 0 &&
    (payload.exp as number) >= 0
  );
}
