import { cookies, headers } from "next/headers";
import { localeCookieName, resolveLocale } from "./locale";

export async function getLocale() {
  return resolveLocale(
    (await cookies()).get(localeCookieName)?.value,
    (await headers()).get("accept-language"),
  );
}
