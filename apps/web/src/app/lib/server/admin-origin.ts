import { webServerConfig } from "./config";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireAdminOrigin(request: Request): Response | null {
  if (safeMethods.has(request.method.toUpperCase())) return null;
  const allowed = webServerConfig().webOrigins;
  const supplied = request.headers.get("origin");
  return supplied && allowed.includes(supplied)
    ? null
    : error(403, "admin_origin_required", "A trusted admin origin is required.");
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}
