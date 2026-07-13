import "server-only";

import { cookies } from "next/headers";
import { adminSessionCookieName } from "./backend-proxy";
import { webServerConfig } from "./config";
import { isValidAdminSessionToken } from "./admin-session";

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
