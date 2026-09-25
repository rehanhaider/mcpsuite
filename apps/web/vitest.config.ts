/**
 * Standalone vitest config: server-side tests run in plain node without the
 * TanStack Start vite plugins (vitest prefers this file over vite.config.ts).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Same "~/*" → src/* resolution as the app (vite.config.ts), so route
  // modules that import through the alias load under test.
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
