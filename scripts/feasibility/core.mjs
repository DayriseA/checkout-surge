import { configuration } from "./common.mjs";
import { setupDatabase, startController } from "./controller.mjs";

const config = configuration();
await setupDatabase(config);
const controller = await startController(config, { ...process.env, PORT: "4500" });
const close = async () => {
  await controller.close();
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void close().then(() => process.exit(0)));
