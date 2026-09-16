import { createHash } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build as viteBuild } from "vite";

const outputRoot = resolve("build/pages");
const fixtureSource = "https://blobs.duckdb.org/data/tpch-sf0.01-parquet/nation.parquet";
const xlsxFixtureSource =
  "https://raw.githubusercontent.com/duckdb/duckdb-excel/27ebb61/test/data/xlsx/google_sheets.xlsx";

async function copy(source: string, destination: string) {
  const target = resolve(outputRoot, destination);
  await mkdir(dirname(target), { recursive: true });
  await cp(resolve(source), target, { recursive: true });
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await viteBuild({ configFile: resolve("vite.demo.config.ts") });

await writeFile(resolve(outputRoot, ".nojekyll"), "");

for (const file of [
  "in-memory-catalog-controller.mjs",
  "in-memory-catalog-metadata-store.js",
  "in-memory-catalog-worker-runtime.js",
  "in-memory-catalog-worker.js",
]) {
  await copy(`dist/${file}`, `in-memory-catalog/${file}`);
}

await copy("node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser.mjs", "duckdb/duckdb-browser.mjs");
await copy("node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm", "duckdb/duckdb-eh.wasm");
await copy(
  "node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js",
  "duckdb/duckdb-browser-eh.worker.js",
);
await copy("node_modules/apache-arrow", "vendor/apache-arrow");
await copy("node_modules/flatbuffers/mjs", "vendor/flatbuffers");
await copy("node_modules/tslib/tslib.es6.mjs", "vendor/tslib/tslib.es6.mjs");
await copy(
  "build/wasm_eh/extension/in_memory_catalog/in_memory_catalog.duckdb_extension.wasm",
  "extension/in_memory_catalog.duckdb_extension.wasm",
);

const fixtureResponse = await fetch(fixtureSource);
if (!fixtureResponse.ok) {
  throw new Error(`Demo Parquet download failed: HTTP ${fixtureResponse.status}`);
}
const fixtureBytes = Buffer.from(await fixtureResponse.arrayBuffer());
const fixturePath = resolve(outputRoot, "data/demo.parquet");
await mkdir(dirname(fixturePath), { recursive: true });
await writeFile(fixturePath, fixtureBytes);

const digest = createHash("sha256").update(fixtureBytes).digest("hex");
const metadata = {
  formatVersion: 1,
  contentVersion: digest,
  bytes: fixtureBytes.byteLength,
  rows: 25,
  columns: [
    { name: "n_nationkey", type: "INTEGER", nullable: true },
    { name: "n_name", type: "VARCHAR", nullable: true },
    { name: "n_regionkey", type: "INTEGER", nullable: true },
    { name: "n_comment", type: "VARCHAR", nullable: true },
  ],
};
await writeFile(resolve(outputRoot, "data/demo.json"), `${JSON.stringify(metadata, null, 2)}\n`);

const csvFixture = [
  "event_id,category,value",
  "1,alpha,10",
  "2,beta,20",
  "3,alpha,15",
  "4,gamma,5",
  "",
].join("\n");
await writeFile(resolve(outputRoot, "data/demo.csv"), csvFixture);

const jsonFixture = [
  {
    event_id: 1,
    context: { browser: "Safari", tags: ["web", "mobile"] },
    payload: { action: "open", duration_ms: 120 },
  },
  {
    event_id: 2,
    context: { browser: "Chrome", tags: ["web", "desktop"] },
    payload: { action: "query", duration_ms: 42 },
  },
];
await writeFile(
  resolve(outputRoot, "data/demo-events.json"),
  `${JSON.stringify(jsonFixture, null, 2)}\n`,
);

const xlsxFixtureResponse = await fetch(xlsxFixtureSource);
if (!xlsxFixtureResponse.ok) {
  throw new Error(`Demo XLSX download failed: HTTP ${xlsxFixtureResponse.status}`);
}
await writeFile(
  resolve(outputRoot, "data/demo.xlsx"),
  Buffer.from(await xlsxFixtureResponse.arrayBuffer()),
);

process.stdout.write(
  `Built GitHub Pages demo: ${metadata.rows} rows, ${fixtureBytes.byteLength.toLocaleString()} bytes\n`,
);
