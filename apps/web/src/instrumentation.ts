export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { initializeWebServerConfig } = await import("./app/lib/server/config");
  initializeWebServerConfig(process.env);
}
