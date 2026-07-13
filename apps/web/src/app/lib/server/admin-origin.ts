import { parseAllowedWebOrigins } from "./admin-config";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireAdminOrigin(request: Request): Response | null {
  if (safeMethods.has(request.method.toUpperCase())) return null;
  const allowed = parseAllowedWebOrigins(process.env.WEB_ORIGIN);
  if (!allowed)
    return error(503, "admin_origin_not_configured", "Admin controls are not configured.");
  const supplied = request.headers.get("origin");
  return supplied && allowed.includes(supplied)
    ? null
    : error(403, "admin_origin_required", "A trusted admin origin is required.");
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}
