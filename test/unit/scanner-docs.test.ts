// The tests intentionally exercise untyped runtime fixtures and source contracts.
// @ts-nocheck
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

const [metadataSource, nativeSource, english, japanese, viteConfig] = await Promise.all([
  readFile(
    new URL("../../src/javascript/in-memory-catalog-metadata-store.ts", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../../src/in_memory_catalog_extension.cpp", import.meta.url), "utf8"),
  readFile(new URL("../../docs/content/scanners.md", import.meta.url), "utf8"),
  readFile(new URL("../../docs/content/ja/scanners.md", import.meta.url), "utf8"),
  readFile(new URL("../../docs/vite.config.ts", import.meta.url), "utf8"),
]);

const csvOptions = [
  "auto_detect",
  "header",
  "delimiter",
  "quote",
  "escape",
  "comment",
  "skip",
  "nullstr",
  "dateformat",
  "timestampformat",
  "compression",
  "ignore_errors",
  "null_padding",
  "allow_quoted_nulls",
  "buffer_size",
  "decimal_separator",
  "encoding",
  "force_not_null",
  "max_line_size",
  "new_line",
  "parallel",
  "sample_size",
  "strict_mode",
  "thousands",
];
const jsonOptions = [
  "format",
  "compression",
  "records",
  "ignore_errors",
  "maximum_object_size",
  "dateformat",
  "timestampformat",
];
const xlsxOptions = [
  "header",
  "sheet",
  "range",
  "all_varchar",
  "ignore_errors",
  "stop_at_empty",
  "empty_as_varchar",
];

describe("Scanner documentation", () => {
  it("documents every CSV option accepted by the metadata store in both locales", () => {
    assert.match(english, /\| Option \| Accepted value \| Default \| Description \|/);
    assert.match(japanese, /\| Option \| 使用できる値 \| 既定値 \| 説明 \|/);
    for (const option of csvOptions) {
      assert.match(metadataSource, new RegExp(`\\b${option}:`));
      assert.match(nativeSource, new RegExp('"' + option + '"'));
      const optionRow = new RegExp("\\| `" + option + "` \\|");
      assert.match(english, optionRow);
      assert.match(japanese, optionRow);
    }
    assert.doesNotMatch(metadataSource, /\bnormalize_names:/);
    assert.doesNotMatch(nativeSource, /"normalize_names"/);
    assert.doesNotMatch(english, /\| `normalize_names` \|/);
    assert.doesNotMatch(japanese, /\| `normalize_names` \|/);
  });

  it("documents every XLSX option accepted by the catalog", () => {
    for (const option of xlsxOptions) {
      assert.match(metadataSource, new RegExp(`\\b${option}:`));
      assert.match(nativeSource, new RegExp('"' + option + '"'));
      const optionRow = new RegExp("\\| `" + option + "` \\|");
      assert.match(english, optionRow);
      assert.match(japanese, optionRow);
    }
  });

  it("documents every JSON option and nested type accepted by the catalog", () => {
    for (const option of jsonOptions) {
      assert.match(metadataSource, new RegExp(`\\b${option}:`));
      assert.match(nativeSource, new RegExp('"' + option + '"'));
      const optionRow = new RegExp("\\| `" + option + "` \\|");
      assert.match(english, optionRow);
      assert.match(japanese, optionRow);
    }
    for (const type of ["JSON", "STRUCT", "LIST"]) {
      assert.match(english, new RegExp("`" + type + "`"));
      assert.match(japanese, new RegExp("`" + type + "`"));
    }
  });

  it("exposes the dedicated scanner page in the documentation navigation", () => {
    assert.match(english, /type: 'parquet'/);
    assert.match(english, /type: 'csv'/);
    assert.match(english, /type: 'json'/);
    assert.match(english, /type: 'xlsx'/);
    assert.match(japanese, /type: 'parquet'/);
    assert.match(japanese, /type: 'csv'/);
    assert.match(japanese, /type: 'json'/);
    assert.match(japanese, /type: 'xlsx'/);
    assert.match(viteConfig, /link: '\/scanners\.md'/);
  });

  it("keeps native numeric validation aligned with the public contract", () => {
    const zeroChecks = nativeSource.match(/\(key == "buffer_size" && number == 0\)/g) ?? [];
    assert.equal(zeroChecks.length, 2);
  });
});
