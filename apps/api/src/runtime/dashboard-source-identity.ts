import { isIP } from "node:net";
import { verifyPublicVisitorCredential } from "@checkout-surge/contracts/public-visitor-credential";

export function normalizeNetworkSource(value: string): string {
  const unwrapped = value.startsWith("[") ? value.slice(1, value.indexOf("]")) : value;
  const withoutZone = unwrapped.split("%")[0] ?? unwrapped;
  const mapped = withoutZone.toLowerCase().startsWith("::ffff:")
    ? withoutZone.slice(7)
    : withoutZone;
  if (isIP(mapped) === 4) return `ip4:${mapped}`;
  if (isIP(mapped) === 6) {
    const groups = expandIpv6(mapped);
    return `ip6:${groups.slice(0, 4).join(":")}:0:0:0:0/64`;
  }
  return "ip:unknown";
}

export function resolveRecoverySource(input: {
  ip: string;
  visitorCredential?: string;
  secret: string;
}): string {
  const visitor = verifyPublicVisitorCredential(input.secret, input.visitorCredential);
  return visitor ? `visitor:${visitor.visitorId}` : normalizeNetworkSource(input.ip);
}

export interface DashboardSourceResolver {
  resolveSse(ip: string): string;
  resolveRecovery(input: { ip: string; visitorCredential?: string }): string;
}

export function createDashboardSourceResolver(secret: string): DashboardSourceResolver {
  return {
    resolveSse: normalizeNetworkSource,
    resolveRecovery: (input) => resolveRecoverySource({ ...input, secret }),
  };
}

function expandIpv6(value: string): string[] {
  const halves = value.toLowerCase().split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  return [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right].map(
    (part) => part.padStart(4, "0"),
  );
}
