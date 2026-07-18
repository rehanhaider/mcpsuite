import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command, isPreview }) => ({
  // The hosted service can mount this build beside its private website without
  // colliding with that application's assets or generated server functions.
  // The !isPreview guard matters if prerendering is ever enabled: the
  // prerender pass resolves this config with command === "serve" (isPreview
  // true), and a non-root base there would 404 every prerendered page.
  base: command === "serve" && !isPreview ? "/_product/" : "/",
  build: { assetsDir: "_product/assets" },
  server: { port: 2222 },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    tanstackStart({
      router: { basepath: "/" },
      serverFns: { base: "/_product/serverFn" },
      prerender: { enabled: false },
    }),
    // react's vite plugin must come after start's
    viteReact(),
  ],
  ssr: {
    // Native module — must stay external to the SSR/server bundle.
    external: ["better-sqlite3"],
  },
}));
