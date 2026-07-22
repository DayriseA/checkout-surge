import "server-only";

import { cookies } from "next/headers";
import { isValidAdminSessionToken } from "./admin-session";
import { adminSessionCookieName } from "./backend-proxy";
import { webServerConfig } from "./config";

export async function hasValidAdminPageSession(): Promise<boolean> {
  const config = webServerConfig();
  const token = (await cookies()).get(adminSessionCookieName)?.value;
  return Boolean(
    token &&
      isValidAdminSessionToken({
        token,
        secret: config.adminSessionSecret,
        nowSeconds: Math.floor(Date.now() / 1000),
        maxAgeSeconds: config.adminSessionMaxAgeSeconds,
      }),
  );
}
