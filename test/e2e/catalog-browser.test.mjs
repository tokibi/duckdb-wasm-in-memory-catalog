import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { chromium } from "playwright";

const pages = resolve("build/pages");

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForServer(url, server) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Pages server exited: ${server.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server has not started listening yet.
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Pages server did not become ready");
}

test(
  "the built extension scans four formats and updates a view after replaceTable",
  { timeout: 180_000 },
  async () => {
    // A second CSV makes the change observable without fetching any external data during the test.
    await writeFile(
      resolve(pages, "data/updated-events.csv"),
      "event_id,category,value\n10,alpha,7\n11,alpha,8\n",
    );
    const port = await availablePort();
    const url = `http://127.0.0.1:${port}/`;
    const server = spawn(
      process.execPath,
      ["--experimental-strip-types", "scripts/serve-pages.ts"],
      {
        env: { ...process.env, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let serverOutput = "";
    server.stdout.on("data", (chunk) => {
      serverOutput += chunk;
    });
    server.stderr.on("data", (chunk) => {
      serverOutput += chunk;
    });
    let browser;
    try {
      await waitForServer(url, server);
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(url);
      // The demo itself must initialize the extension in a real browser.
      await page.locator("#runtime-status[data-state=ready]").waitFor({ timeout: 90_000 });
      await page.locator("#run-demo").click();
      await page.locator("#query-message[data-kind=success]").waitFor({ timeout: 30_000 });
      assert.match(await page.locator("#result-summary").textContent(), /5 rows/);

      const actual = await page.evaluate(async () => {
        const duckdb = await import("/duckdb/duckdb-browser.mjs");
        const { createInMemoryCatalogWorker, InMemoryCatalogController } =
          await import("/in-memory-catalog/in-memory-catalog-controller.mjs");
        const metadata = await (await fetch("/data/demo.json")).json();
        const file = (name) => new URL(`/data/${name}`, location.href).href;
        const csvTable = (name) => ({
          name: "events_csv",
          snapshot: name,
          scanner: { type: "csv", options: { header: true } },
          columns: [
            { name: "event_id", type: "INTEGER", nullable: false },
            { name: "category", type: "VARCHAR", nullable: false },
            { name: "value", type: "INTEGER", nullable: false },
          ],
          files: [file(name)],
        });
        const snapshot = {
          format_version: 1,
          schemas: [
            {
              name: "analytics",
              tables: [
                {
                  name: "nation",
                  snapshot: metadata.contentVersion,
                  scanner: { type: "parquet", options: {} },
                  columns: metadata.columns,
                  files: [file("demo.parquet")],
                },
                csvTable("demo.csv"),
                {
                  name: "events_json",
                  snapshot: "json-v1",
                  scanner: { type: "json", options: { format: "array", records: "true" } },
                  columns: [
                    { name: "event_id", type: "INTEGER", nullable: false },
                    {
                      name: "context",
                      type: "STRUCT(browser VARCHAR, tags VARCHAR[])",
                      nullable: true,
                    },
                    { name: "payload", type: "JSON", nullable: true },
                  ],
                  files: [file("demo-events.json")],
                },
                {
                  name: "spreadsheet_xlsx",
                  snapshot: "xlsx-v1",
                  scanner: { type: "xlsx", options: { header: true } },
                  columns: [
                    { name: "ABC", type: "DOUBLE", nullable: true },
                    { name: "HELLO", type: "VARCHAR", nullable: true },
                    { name: "WORLD", type: "VARCHAR", nullable: true },
                  ],
                  files: [file("demo.xlsx")],
                },
              ],
              views: [
                {
                  name: "event_totals",
                  query: "SELECT category, sum(value) AS total FROM events_csv GROUP BY category",
                },
              ],
            },
          ],
        };
        const worker = createInMemoryCatalogWorker({
          duckdbWorker: new URL("/duckdb/duckdb-browser-eh.worker.js", location.href),
          workerUrl: new URL("/in-memory-catalog/in-memory-catalog-worker.js", location.href),
        });
        const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
        let catalog;
        try {
          await db.instantiate(new URL("/duckdb/duckdb-eh.wasm", location.href).href);
          await db.open({
            allowUnsignedExtensions: true,
            maximumThreads: 1,
            query: { castBigIntToDouble: true },
            filesystem: {
              reliableHeadRequests: false,
              allowFullHTTPReads: true,
              forceFullHTTPReads: false,
            },
          });
          catalog = await InMemoryCatalogController.initialize(
            db,
            worker,
            {
              workspaceId: `e2e-${crypto.randomUUID()}`,
              catalogName: "test_catalog",
              extension: {
                url: new URL("/extension/in_memory_catalog.duckdb_extension.wasm", location.href)
                  .href,
              },
            },
            snapshot,
          );
          const queryNumber = async (sql) =>
            Number((await catalog.connection.query(sql)).toArray()[0].result);
          const before = {
            parquet: await queryNumber(
              "SELECT count(*) AS result FROM test_catalog.analytics.nation",
            ),
            csv: await queryNumber(
              "SELECT sum(value) AS result FROM test_catalog.analytics.events_csv",
            ),
            json: await queryNumber(
              "SELECT count(*) AS result FROM test_catalog.analytics.events_json WHERE context.browser = 'Safari'",
            ),
            xlsx: await queryNumber(
              "SELECT count(*) AS result FROM test_catalog.analytics.spreadsheet_xlsx",
            ),
            view: await queryNumber(
              "SELECT total AS result FROM test_catalog.analytics.event_totals WHERE category = 'alpha'",
            ),
          };
          await catalog.replaceTable("analytics", csvTable("updated-events.csv"));
          const after = {
            csv: await queryNumber(
              "SELECT sum(value) AS result FROM test_catalog.analytics.events_csv",
            ),
            view: await queryNumber(
              "SELECT total AS result FROM test_catalog.analytics.event_totals WHERE category = 'alpha'",
            ),
          };
          return { before, after };
        } finally {
          await catalog?.close();
          await db.terminate();
          worker.terminate();
        }
      });
      assert.equal(actual.before.parquet, 25);
      assert.equal(actual.before.csv, 50);
      assert.equal(actual.before.json, 1);
      assert.ok(actual.before.xlsx > 0, "XLSX should return rows");
      assert.equal(actual.before.view, 25);
      assert.deepEqual(actual.after, { csv: 15, view: 15 });
      assert.deepEqual(pageErrors, []);
    } catch (error) {
      error.message += `\nPages server output:\n${serverOutput}`;
      throw error;
    } finally {
      await browser?.close();
      server.kill();
      if (server.exitCode === null) await once(server, "exit");
    }
  },
);
