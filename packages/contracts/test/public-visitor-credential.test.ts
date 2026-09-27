import { describe, expect, it } from "vitest";
import {
  parsePublicVisitorCredential,
  signPublicVisitorCredential,
  verifyPublicVisitorCredential,
} from "../src/public-visitor-credential.js";

const secret = "fixture-cookie-secret";
const visitorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const signedFixture = () => signPublicVisitorCredential(secret, visitorId, 1234);

describe("public visitor credentials", () => {
  it("round trips a constant-format signed UUID and issued-at value", () => {
    const value = signedFixture();
    expect(value).toMatch(/^[0-9a-f-]{36}\.1234\.[0-9a-f]{64}$/);
    expect(parsePublicVisitorCredential(value)).toEqual({ visitorId, issuedAt: 1234 });
    expect(verifyPublicVisitorCredential(secret, value)).toEqual({ visitorId, issuedAt: 1234 });
  });

  it("rejects missing, weak, and wrong secrets", () => {
    const value = signedFixture();
    expect(verifyPublicVisitorCredential(undefined, value)).toBeNull();
    expect(verifyPublicVisitorCredential("weak", value)).toBeNull();
    expect(verifyPublicVisitorCredential("wrong-fixture-secret", value)).toBeNull();
  });

  it("rejects malformed fields, UUIDs, timestamps, and signatures", () => {
    expect(parsePublicVisitorCredential("too.few")).toBeNull();
    expect(parsePublicVisitorCredential(`too.many.fields.${"0".repeat(64)}`)).toBeNull();
    expect(parsePublicVisitorCredential(`not-a-uuid.1234.${"0".repeat(64)}`)).toBeNull();
    expect(parsePublicVisitorCredential(`${visitorId}.nope.${"0".repeat(64)}`)).toBeNull();
    expect(parsePublicVisitorCredential(`${visitorId}.01234.${"0".repeat(64)}`)).toBeNull();
    expect(
      parsePublicVisitorCredential(`${visitorId}.${Number.MAX_SAFE_INTEGER + 1}.${"0".repeat(64)}`),
    ).toBeNull();
    expect(verifyPublicVisitorCredential(secret, `${visitorId}.1234.short`)).toBeNull();
    expect(verifyPublicVisitorCredential(secret, `${visitorId}.1234.${"z".repeat(64)}`)).toBeNull();
  });

  it("rejects visitor, issued-at, and signature tampering", () => {
    const value = signedFixture();
    expect(
      verifyPublicVisitorCredential(
        secret,
        value.replace(visitorId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      ),
    ).toBeNull();
    expect(verifyPublicVisitorCredential(secret, value.replace(".1234.", ".1235."))).toBeNull();
    expect(verifyPublicVisitorCredential(secret, `${value.slice(0, -1)}0`)).toBeNull();
  });
});
