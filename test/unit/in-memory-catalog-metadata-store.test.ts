// The tests intentionally exercise untyped runtime fixtures and source contracts.
// @ts-nocheck
import assert from "node:assert/strict";
import { describe, it } from "vitest";

await import("../../src/javascript/in-memory-catalog-metadata-store");

const { InMemoryCatalogError, InMemoryCatalogMetadataStore } =
  globalThis.DuckDBInMemoryCatalogMetadata;

function snapshot(uri = "https://example.test/table") {
  return {
    format_version: 2,
    schemas: [
      {
        name: "main",
        tables: [
          {
            name: "table1",
            snapshot: "snapshot-1",
            scanner: { type: "parquet", options: {} },
            columns: [{ name: "id", type: "BIGINT", nullable: false }],
            files: [{ uri }],
          },
        ],
      },
    ],
  };
}

function table(name, snapshotId, uri) {
  return {
    name,
    snapshot: snapshotId,
    scanner: { type: "parquet", options: {} },
    columns: [{ name: "id", type: "BIGINT", nullable: false }],
    files: [{ uri }],
  };
}

function view(name = "view1", query = "SELECT id FROM table1") {
  return { name, query };
}

function viewSnapshot() {
  return {
    format_version: 3,
    schemas: [
      {
        name: "main",
        tables: [table("table1", "snapshot-1", "https://example.test/table")],
        views: [view()],
      },
    ],
  };
}

function multiTableSnapshot(suffix = "initial") {
  return {
    format_version: 2,
    schemas: [
      {
        name: "main",
        tables: [
          table("table1", `${suffix}-table1`, `https://example.test/${suffix}-table1`),
          table("table2", `${suffix}-table2`, `https://example.test/${suffix}-table2`),
        ],
      },
      {
        name: "archive",
        tables: [table("events", `${suffix}-events`, `https://example.test/${suffix}-events`)],
      },
    ],
  };
}

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof InMemoryCatalogError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("InMemoryCatalogMetadataStore", () => {
  it("orders mixed full and table replacements and preserves unrelated table objects", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");

    await session.replaceCatalogSnapshot(multiTableSnapshot());
    const nextSnapshot = multiTableSnapshot("full");
    nextSnapshot.schemas[0].name = "MAIN";
    const full = session.replaceCatalogSnapshot(nextSnapshot);
    const replacement = table("TABLE1", "table-update", "https://example.test/table-update");
    replacement.columns.push({ name: "value", type: "VARCHAR", nullable: true });
    const partial = session.replaceCatalogTable("main", replacement);
    await Promise.all([full, partial]);

    assert.equal(store.currentRevision("workspace"), 3n);
    const updatedTable1 = store.lookupTable("workspace", "3", "main", "table1");
    assert.equal(updatedTable1.name, "table1");
    assert.equal(updatedTable1.snapshot, "table-update");
    assert.equal(updatedTable1.files[0].uri, "https://example.test/table-update");
    assert.deepEqual(
      store.listTables("workspace", "3", "main").find((entry) => entry.name === "table1").columns,
      [
        { name: "id", type: "BIGINT", nullable: false },
        { name: "value", type: "VARCHAR", nullable: true },
      ],
    );
    assert.equal(store.listSchemas("workspace", "3")[0], "MAIN");

    const preservedTable2 = store.lookupTable("workspace", "3", "main", "table2");
    const preservedArchive = store.lookupTable("workspace", "3", "archive", "events");
    await session.replaceCatalogTable(
      "main",
      table("TABLE1", "table-update-again", "https://example.test/table-update-again"),
    );
    assert.equal(store.lookupTable("workspace", "4", "main", "table2"), preservedTable2);
    assert.equal(store.lookupTable("workspace", "4", "archive", "events"), preservedArchive);
  });

  it("resolves missing targets at execution, retains state after errors, and captures table input", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");
    await session.replaceCatalogSnapshot(multiTableSnapshot());
    const original = store.lookupTable("workspace", "1", "main", "table1");

    await expectCode(
      () =>
        session.replaceCatalogTable(
          "missing",
          table("table1", "missing", "https://example.test/missing"),
        ),
      "RC_CATALOG_SCHEMA_NOT_FOUND",
    );
    await expectCode(
      () =>
        session.replaceCatalogTable(
          "main",
          table("missing", "missing", "https://example.test/missing"),
        ),
      "RC_CATALOG_TABLE_NOT_FOUND",
    );
    const invalid = table("TABLE1", "invalid", "https://example.test/invalid");
    invalid.files = [];
    await expectCode(() => session.replaceCatalogTable("MAIN", invalid), "RC_METADATA_INVALID");
    assert.equal(store.currentRevision("workspace"), 1n);
    assert.equal(store.lookupTable("workspace", "1", "main", "table1"), original);

    const candidate = table("TaBlE1", "captured", "https://example.test/captured");
    const update = session.replaceCatalogTable("MAIN", candidate);
    candidate.snapshot = "mutated-after-submit";
    candidate.files[0].uri = "https://example.test/mutated-after-submit";
    await update;
    assert.equal(store.currentRevision("workspace"), 2n);
    const captured = store.lookupTable("workspace", "2", "main", "table1");
    assert.equal(captured.snapshot, "captured");
    assert.equal(captured.files[0].uri, "https://example.test/captured");
  });

  it("publishes scanner and URI metadata while keeping enumeration descriptors lightweight", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");

    await session.replaceCatalogSnapshot(snapshot());

    assert.equal(store.currentRevision("workspace"), 1n);
    assert.deepEqual(store.listSchemas("workspace", "1"), ["main"]);
    assert.deepEqual(store.listViews("workspace", "1", "main"), []);
    assert.deepEqual(store.listTables("workspace", "1", "main"), [
      {
        name: "table1",
        columns: [{ name: "id", type: "BIGINT", nullable: false }],
      },
    ]);
    const table = store.lookupTable("workspace", "1", "main", "table1");
    assert.deepEqual(table.scanner, { type: "parquet", options: {} });
    assert.deepEqual(table.files, [{ uri: "https://example.test/table" }]);
    assert.doesNotMatch(
      JSON.stringify(store.listTables("workspace", "1", "main")),
      /uri|files|scanner/,
    );
  });

  it("publishes views without file metadata and keeps table and view names unique", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");

    await session.replaceCatalogSnapshot(viewSnapshot());

    assert.deepEqual(store.listViews("workspace", "1", "main"), [view()]);
    assert.deepEqual(store.lookupView("workspace", "1", "main", "VIEW1"), view());
    assert.deepEqual(store.lookupTable("workspace", "1", "main", "table1").files, [
      { uri: "https://example.test/table" },
    ]);

    const collision = viewSnapshot();
    collision.schemas[0].views[0].name = "TABLE1";
    await expectCode(() => session.replaceCatalogSnapshot(collision), "RC_METADATA_INVALID");

    const legacy = snapshot();
    legacy.schemas[0].views = [view()];
    await expectCode(() => session.replaceCatalogSnapshot(legacy), "RC_METADATA_VERSION");
    assert.equal(store.currentRevision("workspace"), 1n);
  });

  it("accepts view-only schemas and validates the exact view shape", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");
    const viewOnly = {
      format_version: 3,
      schemas: [{ name: "main", views: [view("constant", "SELECT 1 AS value")] }],
    };

    await session.replaceCatalogSnapshot(viewOnly);
    assert.deepEqual(store.listTables("workspace", "1", "main"), []);
    assert.deepEqual(store.listViews("workspace", "1", "main"), [
      view("constant", "SELECT 1 AS value"),
    ]);

    const withColumns = structuredClone(viewOnly);
    withColumns.schemas[0].views[0].columns = [{ name: "value", type: "INTEGER" }];
    await expectCode(() => session.replaceCatalogSnapshot(withColumns), "RC_METADATA_INVALID");

    const duplicate = structuredClone(viewOnly);
    duplicate.schemas[0].views.push(view("CONSTANT", "SELECT 2 AS value"));
    await expectCode(() => session.replaceCatalogSnapshot(duplicate), "RC_METADATA_INVALID");

    const emptyQuery = structuredClone(viewOnly);
    emptyQuery.schemas[0].views[0].query = "   ";
    await expectCode(() => session.replaceCatalogSnapshot(emptyQuery), "RC_METADATA_INVALID");
    assert.equal(store.currentRevision("workspace"), 1n);
  });

  it("replaces an existing view atomically and keeps the catalog on format version 3", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");
    await session.replaceCatalogSnapshot(viewSnapshot());

    const replacement = view("VIEW1", "SELECT id FROM table1 WHERE id > 10");
    const update = session.replaceCatalogView("MAIN", replacement);
    replacement.query = "SELECT id FROM table1 WHERE id > 20";
    await update;

    assert.deepEqual(
      store.lookupView("workspace", "2", "main", "view1"),
      view("view1", "SELECT id FROM table1 WHERE id > 10"),
    );
    assert.equal(store.lookupTable("workspace", "2", "main", "table1").name, "table1");
    assert.equal(store.currentRevision("workspace"), 2n);

    await expectCode(
      () => session.replaceCatalogView("main", view("missing", "SELECT 1")),
      "RC_CATALOG_VIEW_NOT_FOUND",
    );
    assert.equal(store.currentRevision("workspace"), 2n);
  });

  it("keeps host file URIs stable when only the table snapshot changes", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");

    const firstSnapshot = snapshot("https://example.test/stable-file");
    await session.replaceCatalogSnapshot(firstSnapshot);
    const firstTable = store.lookupTable("workspace", "1", "main", "table1");

    const secondSnapshot = snapshot("https://example.test/stable-file");
    secondSnapshot.schemas[0].tables[0].snapshot = "snapshot-2";
    await session.replaceCatalogSnapshot(secondSnapshot);
    const secondTable = store.lookupTable("workspace", "2", "main", "table1");

    assert.deepEqual(firstTable.files, [{ uri: "https://example.test/stable-file" }]);
    assert.deepEqual(secondTable.files, [{ uri: "https://example.test/stable-file" }]);
    assert.equal(firstTable.snapshot, "snapshot-1");
    assert.equal(secondTable.snapshot, "snapshot-2");
  });

  it("assigns generations to ordered publications and rejects old bridge reads", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");
    const candidate = snapshot();
    const first = session.replaceCatalogSnapshot(candidate);
    candidate.schemas[0].tables[0].name = "renamed";
    const second = session.replaceCatalogSnapshot(candidate);
    candidate.schemas[0].tables[0].name = "not-submitted";
    await Promise.all([first, second]);

    assert.equal(store.currentRevision("workspace"), 2n);
    assert.equal(store.listTables("workspace", "2", "main")[0].name, "renamed");
    assert.equal(store.lookupTable("workspace", "2", "main", "renamed").snapshot, "snapshot-1");
    assert.throws(
      () => store.listTables("workspace", "1", "main"),
      (error) => error.code === "RC_METADATA_REVISION_CHANGED",
    );
    await session.replaceCatalogSnapshot(snapshot());
    await session.replaceCatalogSnapshot(snapshot());
    assert.equal(store.currentRevision("workspace"), 4n);
    assert.equal(store.diagnostics().retained_workspace_snapshot_count, 1);
  });

  it("keeps the published state and generation after failed validation, then accepts the next publication", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");
    await session.replaceCatalogSnapshot(snapshot());
    const invalid = snapshot();
    invalid.schemas[0].tables[0].files = [];
    await expectCode(() => session.replaceCatalogSnapshot(invalid), "RC_METADATA_INVALID");
    assert.equal(store.currentRevision("workspace"), 1n);
    assert.equal(
      store.lookupTable("workspace", "1", "main", "table1").files[0].uri,
      "https://example.test/table",
    );
    await session.replaceCatalogSnapshot(snapshot("https://example.test/new"));
    assert.equal(store.currentRevision("workspace"), 2n);
    assert.equal(
      store.lookupTable("workspace", "2", "main", "table1").files[0].uri,
      "https://example.test/new",
    );
  });

  it("requires an explicit supported scanner and validates csv options", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");

    const missing = snapshot();
    delete missing.schemas[0].tables[0].scanner;
    await expectCode(() => session.replaceCatalogSnapshot(missing), "RC_METADATA_INVALID");

    const supportedCsv = snapshot();
    supportedCsv.schemas[0].tables[0].scanner = {
      type: "csv",
      options: {
        delimiter: "\t",
        header: true,
        quote: "",
        escape: "",
        comment: "",
        skip: 1,
        nullstr: ["", "NULL"],
        allow_quoted_nulls: false,
        buffer_size: 4096,
        decimal_separator: ",",
        encoding: "utf-8",
        force_not_null: ["id"],
        max_line_size: 0,
        new_line: "\\n",
        parallel: false,
        sample_size: -1,
        strict_mode: true,
        thousands: "",
      },
    };
    await session.replaceCatalogSnapshot(supportedCsv);
    assert.deepEqual(
      store.lookupTable("workspace", "1", "main", "table1").scanner,
      supportedCsv.schemas[0].tables[0].scanner,
    );

    const unsupported = snapshot();
    unsupported.schemas[0].tables[0].scanner.type = "yaml";
    await expectCode(() => session.replaceCatalogSnapshot(unsupported), "RC_SCANNER_UNSUPPORTED");

    const options = snapshot();
    options.schemas[0].tables[0].scanner.type = "csv";
    options.schemas[0].tables[0].scanner.options = { hive_partitioning: true };
    await expectCode(() => session.replaceCatalogSnapshot(options), "RC_METADATA_INVALID");

    for (const invalidOption of ["all_varchar", "normalize_names"]) {
      const excluded = snapshot();
      excluded.schemas[0].tables[0].scanner.type = "csv";
      excluded.schemas[0].tables[0].scanner.options = { [invalidOption]: true };
      await expectCode(() => session.replaceCatalogSnapshot(excluded), "RC_METADATA_INVALID");
    }

    for (const [option, value] of [
      ["force_not_null", ["id", 1]],
      ["force_not_null", []],
      ["sample_size", 0],
      ["sample_size", -2],
      ["buffer_size", 0],
      ["max_line_size", -1],
    ]) {
      const invalidTypes = snapshot();
      invalidTypes.schemas[0].tables[0].scanner.type = "csv";
      invalidTypes.schemas[0].tables[0].scanner.options = { [option]: value };
      await expectCode(() => session.replaceCatalogSnapshot(invalidTypes), "RC_METADATA_INVALID");
    }

    assert.equal(store.currentRevision("workspace"), 1n);
  });

  it("accepts json scanner options and recursively nested column types", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");
    const candidate = snapshot();
    candidate.schemas[0].tables[0].scanner = {
      type: "json",
      options: {
        format: "newline_delimited",
        compression: "auto_detect",
        records: "false",
        ignore_errors: true,
        maximum_object_size: 16777216,
        dateformat: "iso",
        timestampformat: "iso",
      },
    };
    candidate.schemas[0].tables[0].columns = [
      { name: "raw", type: "JSON", nullable: false },
      { name: "profile", type: "STRUCT(name VARCHAR, tags VARCHAR[])", nullable: true },
      { name: "events", type: "LIST(STRUCT(id BIGINT, payload JSON))", nullable: true },
    ];

    await session.replaceCatalogSnapshot(candidate);
    assert.deepEqual(
      store.lookupTable("workspace", "1", "main", "table1").columns,
      candidate.schemas[0].tables[0].columns,
    );
  });

  it("rejects unsupported or malformed nested column types and json options", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");
    for (const type of [
      "MAP(VARCHAR, VARCHAR)",
      "STRUCT(name VARCHAR",
      "STRUCT(name VARCHAR, NAME BIGINT)",
      "LIST(DECIMAL(10, 2))",
      "struct(name VARCHAR)",
    ]) {
      const candidate = snapshot();
      candidate.schemas[0].tables[0].columns[0].type = type;
      await expectCode(() => session.replaceCatalogSnapshot(candidate), "RC_METADATA_INVALID");
    }

    for (const [option, value] of [
      ["format", "nd"],
      ["records", false],
      ["maximum_object_size", 0],
      ["sample_size", 100],
    ]) {
      const candidate = snapshot();
      candidate.schemas[0].tables[0].scanner = { type: "json", options: { [option]: value } };
      await expectCode(() => session.replaceCatalogSnapshot(candidate), "RC_METADATA_INVALID");
    }
  });

  it("accepts xlsx scanner options for exactly one file", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");
    const candidate = snapshot("https://example.test/table.xlsx");
    candidate.schemas[0].tables[0].scanner = {
      type: "xlsx",
      options: {
        header: true,
        sheet: "Data",
        range: "A1:C20",
        all_varchar: false,
        ignore_errors: true,
        stop_at_empty: false,
        empty_as_varchar: true,
      },
    };

    await session.replaceCatalogSnapshot(candidate);
    assert.deepEqual(
      store.lookupTable("workspace", "1", "main", "table1").scanner,
      candidate.schemas[0].tables[0].scanner,
    );
  });

  it("rejects unsupported xlsx options, malformed values, and multiple files", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");
    for (const [option, value] of [
      ["normalize_names", true],
      ["sheet", ""],
      ["range", false],
      ["header", "true"],
    ]) {
      const candidate = snapshot("https://example.test/table.xlsx");
      candidate.schemas[0].tables[0].scanner = { type: "xlsx", options: { [option]: value } };
      await expectCode(() => session.replaceCatalogSnapshot(candidate), "RC_METADATA_INVALID");
    }

    const multiple = snapshot("https://example.test/table.xlsx");
    multiple.schemas[0].tables[0].scanner = { type: "xlsx", options: {} };
    multiple.schemas[0].tables[0].files.push({ uri: "https://example.test/table-2.xlsx" });
    await expectCode(() => session.replaceCatalogSnapshot(multiple), "RC_METADATA_INVALID");
  });

  it("rejects the previous snapshot format instead of choosing a scanner implicitly", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");
    const legacy = snapshot();
    legacy.format_version = 1;

    await expectCode(() => session.replaceCatalogSnapshot(legacy), "RC_METADATA_VERSION");
  });

  it("enumerates 100,000 tables without full lookup or URI transfer", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");
    const candidate = snapshot();
    const template = candidate.schemas[0].tables[0];
    candidate.schemas[0].tables = Array.from({ length: 100_000 }, (_, index) => ({
      ...structuredClone(template),
      name: `table${index + 1}`,
    }));

    await session.replaceCatalogSnapshot(candidate);
    const tables = store.listTables("workspace", "1", "main");

    assert.equal(tables.length, 100_000);
    assert.deepEqual(store.diagnostics(), {
      active_workspace_session_count: 1,
      retained_workspace_snapshot_count: 1,
      retained_catalog_revision_state: 1,
      full_lookup_count: 0,
      uri_descriptor_transfer_count: 0,
    });
  });

  it("rejects extra file metadata and duplicate URIs atomically", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");
    const legacy = snapshot();
    legacy.schemas[0].tables[0].files[0].hash = `sha256:${"a".repeat(64)}`;

    await expectCode(() => session.replaceCatalogSnapshot(legacy), "RC_METADATA_INVALID");
    assert.equal(store.hasWorkspace("workspace"), true);
    assert.equal(store.currentRevision("workspace"), undefined);

    const duplicate = snapshot();
    duplicate.schemas[0].tables[0].files.push({
      uri: "https://example.test/table",
    });
    await expectCode(() => session.replaceCatalogSnapshot(duplicate), "RC_METADATA_INVALID");
  });

  it("enforces one writer and releases all workspace state on revisionless drop", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");

    assert.throws(
      () => store.openWorkspaceSession("workspace"),
      (error) => error.code === "RC_CATALOG_WORKSPACE_ALREADY_ACTIVE",
    );
    await session.replaceCatalogSnapshot(snapshot());
    await session.dropCatalogWorkspace();

    assert.deepEqual(store.diagnostics(), {
      active_workspace_session_count: 0,
      retained_workspace_snapshot_count: 0,
      retained_catalog_revision_state: 0,
      full_lookup_count: 0,
      uri_descriptor_transfer_count: 0,
    });
    await expectCode(
      () => session.replaceCatalogSnapshot(snapshot()),
      "RC_CATALOG_WORKSPACE_CLOSED",
    );

    const replacement = store.openWorkspaceSession("workspace");
    await replacement.replaceCatalogSnapshot(snapshot());
    assert.equal(store.currentRevision("workspace"), 1n);
  });

  it("drops after a rejected pending replacement instead of leaking the session", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const session = store.openWorkspaceSession("workspace");
    const invalid = snapshot();
    invalid.schemas[0].tables[0].files = [];

    await expectCode(() => session.replaceCatalogSnapshot(invalid), "RC_METADATA_INVALID");
    await session.dropCatalogWorkspace();

    assert.equal(store.diagnostics().active_workspace_session_count, 0);
  });
});
