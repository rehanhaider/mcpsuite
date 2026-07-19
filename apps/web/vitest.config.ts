/**
 * Standalone vitest config: server-side tests run in plain node without the
 * TanStack Start vite plugins (vitest prefers this file over vite.config.ts).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
