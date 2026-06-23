import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const publicVisitorCookieName = "checkout_surge_public_visitor";
const publicVisitorMaxAgeSeconds = 365 * 24 * 60 * 60;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PublicVisitorIdentity {
  id: string;
  setCookie?: string;
}

export function resolvePublicVisitorIdentity(request: Request): PublicVisitorIdentity | Response {
  const secret = process.env.PUBLIC_CLIENT_COOKIE_SECRET?.trim();

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
    return { id: existing };
  }

  const id = randomUUID();
  return {
    id,
    setCookie: serializePublicVisitorCookie(id, secret, request),
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

  const separatorIndex = decoded.lastIndexOf(".");
  if (separatorIndex <= 0) {
    return null;
  }

  const id = decoded.slice(0, separatorIndex);
  const signature = decoded.slice(separatorIndex + 1);

  if (!uuidPattern.test(id) || !isValidSignature(id, signature, secret)) {
    return null;
  }

  return id;
}

function serializePublicVisitorCookie(id: string, secret: string, request: Request): string {
  const signedValue = `${id}.${sign(id, secret)}`;
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

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function isValidSignature(value: string, signature: string, secret: string): boolean {
  const expected = sign(value, secret);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);

  return (
    expectedBuffer.byteLength === actualBuffer.byteLength &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}
