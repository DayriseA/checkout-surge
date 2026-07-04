import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// The app reads its data straight from ../results — the repo's results folder
// is the single source of truth; nothing is copied into web/.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    fs: {
      // allow importing ../results/** (reports + data) from the dev server
      allow: [fileURLToPath(new URL("..", import.meta.url))],
    },
  },
});
