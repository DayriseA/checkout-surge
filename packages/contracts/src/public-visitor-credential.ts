import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { nonnegativeIntegerSchema, uuidSchema } from "./primitives.js";

export const publicVisitorCookieName = "checkout_surge_public_visitor" as const;
export const publicVisitorCredentialSchema = z
  .object({ visitorId: uuidSchema, issuedAt: nonnegativeIntegerSchema })
  .strict();
export type PublicVisitorCredential = z.infer<typeof publicVisitorCredentialSchema>;
export const publicVisitorCredentialMinimumSecretBytes = 16;
export function isValidPublicVisitorCredentialSecret(secret: string | undefined): secret is string {
  return Boolean(
    secret && Buffer.byteLength(secret, "utf8") >= publicVisitorCredentialMinimumSecretBytes,
  );
}

export function signPublicVisitorCredential(
  secret: string,
  visitorId: string,
  issuedAt: number,
): string | null {
  const parsed = publicVisitorCredentialSchema.safeParse({ visitorId, issuedAt });
  if (!parsed.success || !isValidPublicVisitorCredentialSecret(secret)) return null;
  const value = `${parsed.data.visitorId}.${parsed.data.issuedAt}`;
  return `${value}.${createHmac("sha256", secret).update(value).digest("hex")}`;
}

export function parsePublicVisitorCredential(value: string): PublicVisitorCredential | null {
  const fields = value.split(".");
  if (fields.length !== 3) return null;
  const [visitorId, issuedAtRaw] = fields;
  if (!visitorId || !issuedAtRaw || !/^\d+$/.test(issuedAtRaw)) return null;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isSafeInteger(issuedAt) || String(issuedAt) !== issuedAtRaw) return null;
  const parsed = publicVisitorCredentialSchema.safeParse({ visitorId, issuedAt });
  return parsed.success ? parsed.data : null;
}

export function verifyPublicVisitorCredential(
  secret: string | undefined,
  value: string | undefined,
): PublicVisitorCredential | null {
  if (!isValidPublicVisitorCredentialSecret(secret) || !value) return null;
  const parsed = parsePublicVisitorCredential(value);
  if (!parsed) return null;
  const canonical = `${parsed.visitorId}.${parsed.issuedAt}`;
  const signature = value.slice(canonical.length + 1);
  if (!/^[0-9a-f]{64}$/.test(signature)) return null;
  const expected = createHmac("sha256", secret).update(canonical).digest("hex");
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))
    ? parsed
    : null;
}
