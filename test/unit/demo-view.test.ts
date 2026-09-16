// The tests intentionally exercise untyped runtime fixtures and source contracts.
// @ts-nocheck
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

const demoRoot = new URL("../../demo/", import.meta.url);
const [appSource, examplesSource, pageSource] = await Promise.all([
  readFile(new URL("app.ts", demoRoot), "utf8"),
  readFile(new URL("query-examples.ts", demoRoot), "utf8"),
  readFile(new URL("index.html", demoRoot), "utf8"),
]);

describe("GitHub Pages demo view examples", () => {
  it("starts with a catalog view backed by the nation table", () => {
    assert.match(appSource, /format_version: 3/);
    assert.match(appSource, /name: ["']nation_counts_by_region["']/);
    assert.match(appSource, /FROM nation/);
    assert.match(appSource, /FROM demo\.analytics\.nation_counts_by_region;/);
    assert.match(appSource, /type: ["']csv["']/);
    assert.match(appSource, /name: ["']events_csv["']/);
    assert.match(appSource, /type: ["']json["']/);
    assert.match(appSource, /name: ["']events_json["']/);
    assert.match(appSource, /STRUCT\(browser VARCHAR, tags VARCHAR\[\]\)/);
    assert.match(appSource, /type: ["']xlsx["']/);
    assert.match(appSource, /name: ["']spreadsheet_xlsx["']/);
  });

  it("provides view metadata and view query examples", () => {
    assert.match(examplesSource, /FROM duckdb_views\(\)/);
    assert.match(examplesSource, /examples\.viewMetadata/);
    assert.match(examplesSource, /examples\.viewRows/);
    assert.match(pageSource, /data-query-example="viewMetadata"/);
    assert.match(pageSource, /data-query-example="viewRows"/);
    assert.match(examplesSource, /examples\.csvRows/);
    assert.match(pageSource, /data-query-example="csvRows"/);
    assert.match(examplesSource, /examples\.jsonRows/);
    assert.match(pageSource, /data-query-example="jsonRows"/);
    assert.match(examplesSource, /examples\.xlsxRows/);
    assert.match(pageSource, /data-query-example="xlsxRows"/);
  });
});
