import { initializeWebServerConfig } from "./app/lib/server/config";

export function register(): void {
  initializeWebServerConfig(process.env);
}
