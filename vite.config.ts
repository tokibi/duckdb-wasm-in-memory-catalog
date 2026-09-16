import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, transformWithOxc, type Plugin } from "vite";

const sourceRoot = resolve("src/javascript");

function classicWorker(): Plugin {
  return {
    name: "in-memory-catalog-classic-worker",
    async generateBundle(_options, bundle) {
      const source = readFileSync(resolve(sourceRoot, "in-memory-catalog-worker.ts"), "utf8");
      const transformed = await transformWithOxc(source, "in-memory-catalog-worker.ts", {
        lang: "ts",
        target: "es2022",
      });
      this.emitFile({
        type: "asset",
        fileName: "in-memory-catalog-worker.js",
        source: transformed.code,
      });
      for (const fileName of [
        "in-memory-catalog-metadata-store.js",
        "in-memory-catalog-worker-runtime.js",
      ]) {
        const chunk = bundle[fileName];
        if (chunk?.type === "chunk") {
          chunk.code = chunk.code.replace(/\nexport \{[\s\S]*?\};?\s*$/, "\n");
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [classicWorker()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: {
        "in-memory-catalog-controller": resolve(sourceRoot, "in-memory-catalog-controller.ts"),
        "in-memory-catalog-metadata-store": resolve(
          sourceRoot,
          "in-memory-catalog-metadata-store.ts",
        ),
        "in-memory-catalog-worker-runtime": resolve(
          sourceRoot,
          "in-memory-catalog-worker-runtime.ts",
        ),
      },
      formats: ["es"],
      fileName: (_, entryName) => {
        if (entryName === "in-memory-catalog-controller") return `${entryName}.mjs`;
        return `${entryName}.js`;
      },
    },
  },
});
