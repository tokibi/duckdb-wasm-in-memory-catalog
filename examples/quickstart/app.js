import {
  createInMemoryCatalogWorker,
  InMemoryCatalogController,
} from "../in-memory-catalog/in-memory-catalog-controller.mjs";

const output = document.querySelector("#output");
const assetRoot = new URL("../", import.meta.url);

let worker;
let database;
let catalog;

async function closeRuntime() {
  await catalog?.close().catch(() => {});
  await database?.terminate().catch(() => {});
  worker?.terminate();
  catalog = undefined;
  database = undefined;
  worker = undefined;
}

window.addEventListener("pagehide", () => void closeRuntime());

try {
  const duckdb = await import(new URL("duckdb/duckdb-browser.mjs", assetRoot).href);
  worker = createInMemoryCatalogWorker({
    duckdbWorker: new URL("duckdb/duckdb-browser-eh.worker.js", assetRoot),
    workerUrl: new URL("in-memory-catalog/in-memory-catalog-worker.js", assetRoot),
  });

  database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await database.instantiate(new URL("duckdb/duckdb-eh.wasm", assetRoot).href);
  await database.open({
    allowUnsignedExtensions: true,
    maximumThreads: 1,
    filesystem: {
      reliableHeadRequests: false,
      allowFullHTTPReads: true,
      forceFullHTTPReads: false,
    },
  });

  const snapshot = {
    format_version: 1,
    schemas: [
      {
        name: "analytics",
        tables: [
          {
            name: "events",
            snapshot: "local-events-v1",
            scanner: { type: "csv", options: { header: true } },
            columns: [
              { name: "event_id", type: "INTEGER", nullable: false },
              { name: "category", type: "VARCHAR", nullable: false },
              { name: "value", type: "INTEGER", nullable: false },
            ],
            files: [new URL("./events.csv", import.meta.url).href],
          },
        ],
        views: [
          {
            name: "category_totals",
            query: "SELECT category, CAST(SUM(value) AS DOUBLE) AS total FROM events GROUP BY category",
          },
        ],
      },
    ],
  };

  catalog = await InMemoryCatalogController.initialize(
    database,
    worker,
    {
      workspaceId: `quickstart-${crypto.randomUUID()}`,
      catalogName: "app",
      extension: {
        url: new URL("extension/in_memory_catalog.duckdb_extension.wasm", assetRoot).href,
      },
    },
    snapshot,
  );

  const result = await catalog.connection.query(
    "SELECT category, total FROM app.analytics.category_totals ORDER BY category",
  );
  const fields = result.schema.fields.map((field) => field.name);
  const rows = result.toArray().map((row) =>
    Object.fromEntries(fields.map((field) => [field, row[field]])),
  );
  output.textContent = JSON.stringify(
    { query: "SELECT category, total FROM app.analytics.category_totals ORDER BY category", rows },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
} catch (error) {
  output.textContent = `Quickstart failed: ${error instanceof Error ? error.stack : String(error)}`;
  await closeRuntime();
}
