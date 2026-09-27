import { signPublicVisitorCredential } from "@checkout-surge/contracts/public-visitor-credential";
import { describe, expect, it } from "vitest";
import {
  normalizeNetworkSource,
  resolveRecoverySource,
} from "../../src/runtime/dashboard-source-identity.js";

describe("dashboard source identity", () => {
  it("normalizes IPv4-mapped addresses and IPv6 /64 prefixes consistently", () => {
    expect(normalizeNetworkSource("::ffff:192.0.2.4")).toBe("ip4:192.0.2.4");
    expect(normalizeNetworkSource("2001:db8:1234:5678::1")).toBe(
      normalizeNetworkSource("2001:0db8:1234:5678:ffff::2"),
    );
  });

  it("accepts only a verified visitor credential and otherwise uses the network source", () => {
    const secret = "test-public-cookie-secret";
    const credential = signPublicVisitorCredential(
      secret,
      "77777777-7777-4777-8777-777777777777",
      1,
    );
    expect(
      resolveRecoverySource({ ip: "192.0.2.4", visitorCredential: credential ?? "", secret }),
    ).toBe("visitor:77777777-7777-4777-8777-777777777777");
    expect(resolveRecoverySource({ ip: "192.0.2.4", visitorCredential: "caller", secret })).toBe(
      "ip4:192.0.2.4",
    );
  });
});
