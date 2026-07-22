import { randomUUID } from "node:crypto";
import {
  publicVisitorCookieName,
  signPublicVisitorCredential,
  verifyPublicVisitorCredential,
} from "@checkout-surge/contracts/public-visitor-credential";
import { jsonError, type ProxyRequestContext } from "./backend-proxy";
import { webServerConfig } from "./config";

const publicVisitorMaxAgeSeconds = 365 * 24 * 60 * 60;

export interface PublicVisitorIdentity {
  credential: string;
  setCookie?: string;
}

export function resolvePublicVisitorIdentity(
  ctx: ProxyRequestContext,
): PublicVisitorIdentity | Response {
  const secret = webServerConfig().publicClientCookieSecret;

  const existing = readSignedVisitorCookie(ctx.request, secret);
  if (existing) {
    return { credential: existing };
  }

  const id = randomUUID();
  const credential = signPublicVisitorCredential(secret, id, Date.now());
  if (!credential) {
    return jsonError(
      ctx,
      503,
      "service_misconfigured",
      "Public visitor cookie signing is not configured.",
    );
  }
  return {
    credential,
    setCookie: serializePublicVisitorCookie(credential, ctx.request),
  };
}

function readSignedVisitorCookie(request: Request, secret: string): string | null {
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
  return verified ? decoded : null;
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
