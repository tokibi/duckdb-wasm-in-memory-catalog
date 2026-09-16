import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve("demo"),
  base: "./",
  build: {
    outDir: resolve("build/pages"),
    emptyOutDir: false,
    rollupOptions: {
      input: resolve("demo/index.html"),
    },
  },
});
