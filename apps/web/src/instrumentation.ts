import { loadWebServerConfig } from "./app/lib/server/config";

export function register(): void {
  loadWebServerConfig(process.env);
}
