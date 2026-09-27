import { randomUUID } from "node:crypto";
import {
  publicVisitorCookieName,
  signPublicVisitorCredential,
  verifyPublicVisitorCredential,
} from "@checkout-surge/contracts/public-visitor-credential";
import type { ProxyRequestContext } from "./backend-proxy";
import { webServerConfig } from "./config";

const publicVisitorMaxAgeSeconds = 365 * 24 * 60 * 60;

export interface PublicVisitorIdentity {
  credential: string;
  setCookie?: string;
}

export interface ExistingPublicVisitorIdentity {
  credential: string;
  visitorId: string;
}

export function resolvePublicVisitorIdentity(ctx: ProxyRequestContext): PublicVisitorIdentity {
  const secret = webServerConfig().publicClientCookieSecret;

  const existing = readPublicVisitorIdentity(ctx.request, secret);
  if (existing) {
    return { credential: existing.credential };
  }

  const id = randomUUID();
  const credential = signPublicVisitorCredential(secret, id, Date.now());
  return {
    credential,
    setCookie: serializePublicVisitorCookie(credential, ctx.request),
  };
}

export function readPublicVisitorIdentity(
  request: Request,
  secret: string,
): ExistingPublicVisitorIdentity | null {
  const rawCookie = request.headers.get("cookie");
  const signedValue = rawCookie
    ?.split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${publicVisitorCookieName}=`))
    ?.slice(publicVisitorCookieName.length + 1);

  if (!signedValue) {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(signedValue);
  } catch {
    return null;
  }

  const verified = verifyPublicVisitorCredential(secret, decoded);
  return verified ? { credential: decoded, visitorId: verified.visitorId } : null;
}

function serializePublicVisitorCookie(signedValue: string, request: Request): string {
  const attributes = [
    `${publicVisitorCookieName}=${encodeURIComponent(signedValue)}`,
    "Path=/",
    `Max-Age=${publicVisitorMaxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (new URL(request.url).protocol === "https:") {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}
