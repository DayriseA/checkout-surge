import { randomUUID } from "node:crypto";
import {
  publicVisitorCookieName,
  signPublicVisitorCredential,
  verifyPublicVisitorCredential,
} from "@checkout-surge/contracts/public-visitor-credential";
import { readWebSecret } from "./config";

const publicVisitorMaxAgeSeconds = 365 * 24 * 60 * 60;

export interface PublicVisitorIdentity {
  credential: string;
  setCookie?: string;
}

export function resolvePublicVisitorIdentity(request: Request): PublicVisitorIdentity | Response {
  const secret = readWebSecret(process.env, "PUBLIC_CLIENT_COOKIE_SECRET");
  if (!secret) {
    return Response.json(
      {
        code: "public_client_cookie_secret_not_configured",
        message: "Public visitor cookie signing is not configured.",
      },
      { status: 503 },
    );
  }

  const existing = readSignedVisitorCookie(request, secret);
  if (existing) {
    return { credential: existing };
  }

  const id = randomUUID();
  const credential = signPublicVisitorCredential(secret, id, Date.now());
  if (!credential) {
    return Response.json(
      {
        code: "public_client_cookie_secret_not_configured",
        message: "Public visitor cookie signing is not configured.",
      },
      { status: 503 },
    );
  }
  return {
    credential,
    setCookie: serializePublicVisitorCookie(credential, request),
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
