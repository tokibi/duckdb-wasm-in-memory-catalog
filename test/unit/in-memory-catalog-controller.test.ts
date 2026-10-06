// The tests intentionally exercise untyped runtime fixtures and source contracts.
// @ts-nocheck
import assert from "node:assert/strict";
import { describe, it } from "vitest";

await import("../../src/javascript/in-memory-catalog-metadata-store");
await import("../../src/javascript/in-memory-catalog-worker-runtime");
const { createInMemoryCatalogWorker, InMemoryCatalogController, InMemoryCatalogControllerError } =
  await import("../../src/javascript/in-memory-catalog-controller");

const { InMemoryCatalogMetadataStore } = globalThis.DuckDBInMemoryCatalogMetadata;
const { createInMemoryCatalogWorkerRuntime } = globalThis.DuckDBInMemoryCatalogWorkerRuntime;

function snapshot(uri = "https://example.test/table") {
  return {
    format_version: 1,
    schemas: [
      {
        name: "main",
        tables: [
          {
            name: "table1",
            snapshot: "snapshot-1",
            scanner: { type: "parquet", options: {} },
            columns: [{ name: "id", type: "BIGINT", nullable: false }],
            files: [uri],
          },
        ],
      },
    ],
  };
}

function viewSnapshot() {
  return {
    format_version: 1,
    schemas: [
      {
        name: "main",
        tables: [
          {
            name: "table1",
            snapshot: "snapshot-1",
            scanner: { type: "parquet", options: {} },
            columns: [{ name: "id", type: "BIGINT", nullable: false }],
            files: ["https://example.test/table"],
          },
        ],
        views: [{ name: "view1", query: "SELECT id FROM table1" }],
      },
    ],
  };
}

function fakeDatabase() {
  const queries = [];
  const connection = {
    closed: false,
    async query(sql) {
      queries.push(sql);
    },
    async close() {
      this.closed = true;
    },
  };
  return {
    db: {
      async connect() {
        return connection;
      },
    },
    connection,
    queries,
  };
}

function runtimeWorker(runtime) {
  return {
    terminated: false,
    postMessage(data, ports) {
      void runtime.handleMessage({ data, ports });
    },
    terminate() {
      this.terminated = true;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("InMemoryCatalogController", () => {
  it("orders fully materialized reads, remote writes, scoped publication, and queued reads", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const worker = runtimeWorker(createInMemoryCatalogWorkerRuntime(store));
    const { db, connection } = fakeDatabase();
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      { workspaceId: "workspace", catalogName: "dataset" },
      snapshot(),
    );
    const readStarted = deferred();
    const finishRead = deferred();
    const writeStarted = deferred();
    const finishWrite = deferred();
    const events = [];
    const originalQuery = connection.query;
    connection.query = async function (sql) {
      assert.equal(this, connection);
      if (sql === "first") {
        events.push("read started");
        readStarted.resolve();
        await finishRead.promise;
        events.push("read finished");
        return [1];
      }
      if (sql === "second") {
        const table = store.lookupTable(
          "workspace",
          store.currentRevision("workspace").toString(),
          "main",
          "table1",
        );
        assert.equal(table.snapshot, "new-version");
        events.push("next read");
        return [2];
      }
      return originalQuery.call(this, sql);
    };
    const first = controller.query("first");
    await readStarted.promise;
    let expiredScope;
    const exclusive = controller.withExclusiveUpdate(async (update) => {
      expiredScope = update;
      events.push("write started");
      writeStarted.resolve();
      await finishWrite.promise;
      events.push("write finished");
      const table = snapshot().schemas[0].tables[0];
      table.snapshot = "new-version";
      // Even an unawaited publication must finish before the next query starts.
      void update.replaceTable("main", table);
      table.snapshot = "not-submitted";
      return "updated";
    });
    const second = controller.query("second");
    await Promise.resolve();
    assert.deepEqual(events, ["read started"]);
    finishRead.resolve();
    await writeStarted.promise;
    await assert.rejects(
      controller.publishSnapshot(snapshot()),
      (error) => error.code === "RC_CATALOG_UPDATE_SCOPE",
    );
    await assert.rejects(
      controller.replaceTable("main", snapshot().schemas[0].tables[0]),
      (error) => error.code === "RC_CATALOG_UPDATE_SCOPE",
    );
    assert.deepEqual(events, ["read started", "read finished", "write started"]);
    const close = controller.close();
    assert.equal(connection.closed, false);
    finishWrite.resolve();
    assert.deepEqual(await first, [1]);
    assert.equal(await exclusive, "updated");
    assert.deepEqual(await second, [2]);
    await close;
    assert.deepEqual(events, [
      "read started",
      "read finished",
      "write started",
      "write finished",
      "next read",
    ]);
    assert.equal(connection.closed, true);
    await assert.rejects(
      expiredScope.publishSnapshot(snapshot()),
      (error) => error.code === "RC_CATALOG_UPDATE_SCOPE",
    );
  });

  it("fails closed on a host failure and blocks queued work even while close drains", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const { db, queries } = fakeDatabase();
    const recovery = [];
    const controller = await InMemoryCatalogController.initialize(
      db,
      runtimeWorker(createInMemoryCatalogWorkerRuntime(store)),
      {
        workspaceId: "workspace",
        catalogName: "dataset",
        onRecoveryRequired: (details) => recovery.push(details),
      },
      snapshot(),
    );
    const started = deferred();
    const fail = deferred();
    const originalError = new Error("remote upload failed");
    const update = controller.withExclusiveUpdate(async () => {
      started.resolve();
      await fail.promise;
      throw originalError;
    });
    const updateRejected = assert.rejects(update, (error) => error === originalError);
    const queryRejected = assert.rejects(
      controller.query("must not run"),
      (error) => error.code === "RC_CATALOG_RECOVERY_REQUIRED",
    );
    const metadataRejected = assert.rejects(
      controller.publishSnapshot(snapshot()),
      (error) => error.code === "RC_CATALOG_RECOVERY_REQUIRED",
    );
    await started.promise;
    const close = controller.close();
    fail.resolve();
    await Promise.all([updateRejected, queryRejected, metadataRejected, close]);
    assert.equal(queries.includes("must not run"), false);
    assert.equal(recovery.length, 1);
    await assert.rejects(
      controller.query("still blocked"),
      (error) => error.code === "RC_CATALOG_RECOVERY_REQUIRED",
    );
    assert.equal(recovery.length, 1);
  });

  it("keeps scoped metadata failures sticky even when the callback catches them", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const { db } = fakeDatabase();
    const controller = await InMemoryCatalogController.initialize(
      db,
      runtimeWorker(createInMemoryCatalogWorkerRuntime(store)),
      { workspaceId: "workspace", catalogName: "dataset" },
      snapshot(),
    );
    try {
      await assert.rejects(
        controller.withExclusiveUpdate(async (update) => {
          await assert.rejects(
            update.publishSnapshot({}),
            (error) => error.code === "RC_METADATA_VERSION",
          );
        }),
        (error) => error.code === "RC_METADATA_VERSION",
      );
      assert.equal(controller.state, "failed_closed");
      await assert.rejects(
        controller.query("blocked"),
        (error) => error.code === "RC_CATALOG_RECOVERY_REQUIRED",
      );
    } finally {
      await controller.close();
    }
  });

  it("requires metadata publication and prevents reuse of a completed update scope", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const { db } = fakeDatabase();
    const controller = await InMemoryCatalogController.initialize(
      db,
      runtimeWorker(createInMemoryCatalogWorkerRuntime(store)),
      { workspaceId: "workspace", catalogName: "dataset" },
      snapshot(),
    );
    try {
      let scope;
      await controller.withExclusiveUpdate(async (update) => {
        scope = update;
        await update.publishSnapshot(snapshot());
      });
      await assert.rejects(
        scope.replaceTable("main", snapshot().schemas[0].tables[0]),
        (error) => error.code === "RC_CATALOG_UPDATE_SCOPE",
      );
      assert.equal(controller.state, "active");
      await assert.rejects(
        controller.withExclusiveUpdate(async () => {}),
        (error) => error.code === "RC_CATALOG_UPDATE_REQUIRED",
      );
      assert.equal(controller.state, "failed_closed");
    } finally {
      await controller.close();
    }
  });

  it("continues after ordinary query errors and preserves the query result", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const { db, connection } = fakeDatabase();
    const controller = await InMemoryCatalogController.initialize(
      db,
      runtimeWorker(createInMemoryCatalogWorkerRuntime(store)),
      { workspaceId: "workspace", catalogName: "dataset" },
      snapshot(),
    );
    const originalQuery = connection.query;
    const rows = { rows: [1, 2] };
    connection.query = async function (sql) {
      assert.equal(this, connection);
      if (sql === "bad query") throw new Error("SQL error");
      if (sql === "good query") return rows;
      return originalQuery.call(this, sql);
    };
    try {
      const bad = assert.rejects(controller.query("bad query"), /SQL error/);
      const good = controller.query("good query");
      await bad;
      assert.equal(await good, rows);
      assert.equal(controller.state, "active");
    } finally {
      await controller.close();
    }
  });

  it("creates a classic catalog Worker around the caller-selected DuckDB Worker", () => {
    const originalWorker = globalThis.Worker;
    const calls = [];
    globalThis.Worker = class FakeWorker {
      constructor(url, options) {
        calls.push({ url, options });
      }
    };

    try {
      const worker = createInMemoryCatalogWorker({
        duckdbWorker: "https://cdn.example.test/duckdb-browser-eh.worker.js",
      });

      assert.ok(worker instanceof globalThis.Worker);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].options.type, "classic");
      assert.equal(
        new URL(calls[0].url.searchParams.get("duckdbWorker")).href,
        "https://cdn.example.test/duckdb-browser-eh.worker.js",
      );
    } finally {
      if (originalWorker === undefined) delete globalThis.Worker;
      else globalThis.Worker = originalWorker;
    }
  });

  it("opens, publishes, attaches, refreshes, then detaches and drops without owning the Worker", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const worker = runtimeWorker(createInMemoryCatalogWorkerRuntime(store));
    const { db, connection, queries } = fakeDatabase();
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      { workspaceId: "workspace", catalogName: "dataset", ackTimeoutMs: 100 },
      snapshot(),
    );

    await controller.publishSnapshot(snapshot("https://example.test/revision-2"));
    assert.equal((await controller.diagnostics()).active_workspace_session_count, 1);
    const firstClose = controller.close();
    const secondClose = controller.close();

    assert.equal(firstClose, secondClose);
    await firstClose;
    assert.deepEqual(queries, [
      "LOAD parquet",
      "LOAD 'in_memory_catalog'",
      "ATTACH 'workspace' AS \"dataset\" (TYPE in_memory_catalog, READ_ONLY)",
      'DETACH "dataset"',
    ]);
    assert.equal(connection.closed, true);
    assert.equal(worker.terminated, false);
    assert.equal(controller.state, "closed");
    assert.equal(store.diagnostics().active_workspace_session_count, 0);
  });

  it("installs an extension from a repository before loading it", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const worker = runtimeWorker(createInMemoryCatalogWorkerRuntime(store));
    const { db, queries } = fakeDatabase();
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      {
        workspaceId: "workspace",
        catalogName: "dataset",
        extension: {
          name: "in_memory_catalog",
          repository: "https://example.test/extensions",
        },
        ackTimeoutMs: 100,
      },
      snapshot(),
    );

    await controller.close();
    assert.deepEqual(queries.slice(0, 4), [
      "LOAD parquet",
      "INSTALL 'in_memory_catalog' FROM 'https://example.test/extensions'",
      "LOAD 'in_memory_catalog'",
      "ATTACH 'workspace' AS \"dataset\" (TYPE in_memory_catalog, READ_ONLY)",
    ]);
  });

  it("loads a directly supplied extension URL", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const worker = runtimeWorker(createInMemoryCatalogWorkerRuntime(store));
    const { db, queries } = fakeDatabase();
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      {
        workspaceId: "workspace",
        catalogName: "dataset",
        extension: { url: "/extensions/in_memory_catalog.duckdb_extension.wasm" },
        ackTimeoutMs: 100,
      },
      snapshot(),
    );

    await controller.close();
    assert.equal(queries[1], "LOAD '/extensions/in_memory_catalog.duckdb_extension.wasm'");
  });

  it("loads json once before publishing a json scanner introduced later", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const worker = runtimeWorker(createInMemoryCatalogWorkerRuntime(store));
    const { db, queries } = fakeDatabase();
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      { workspaceId: "workspace", catalogName: "dataset", ackTimeoutMs: 100 },
      snapshot(),
    );
    try {
      const jsonSnapshot = snapshot("https://example.test/table.json");
      jsonSnapshot.schemas[0].tables[0].scanner = {
        type: "json",
        options: { format: "array", records: "true" },
      };
      jsonSnapshot.schemas[0].tables[0].columns = [
        { name: "payload", type: "STRUCT(id BIGINT, tags VARCHAR[])", nullable: true },
      ];
      await controller.publishSnapshot(jsonSnapshot);

      const replacement = structuredClone(jsonSnapshot.schemas[0].tables[0]);
      replacement.columns = [{ name: "payload", type: "JSON", nullable: true }];
      await controller.replaceTable("main", replacement);

      assert.equal(queries.filter((query) => query === "LOAD json").length, 1);
      assert.ok(
        queries.indexOf("LOAD json") >
          queries.indexOf("ATTACH 'workspace' AS \"dataset\" (TYPE in_memory_catalog, READ_ONLY)"),
      );
    } finally {
      await controller.close();
    }
  });

  it("loads json for a JSON column even when the scanner is parquet", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const worker = runtimeWorker(createInMemoryCatalogWorkerRuntime(store));
    const { db, queries } = fakeDatabase();
    const initial = snapshot();
    initial.schemas[0].tables[0].columns = [{ name: "payload", type: "JSON", nullable: true }];
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      { workspaceId: "workspace", catalogName: "dataset", ackTimeoutMs: 100 },
      initial,
    );

    await controller.close();
    assert.equal(queries.filter((query) => query === "LOAD json").length, 1);
    assert.ok(
      queries.indexOf("LOAD json") <
        queries.indexOf("ATTACH 'workspace' AS \"dataset\" (TYPE in_memory_catalog, READ_ONLY)"),
    );
  });

  it("loads excel once before publishing an xlsx scanner", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const worker = runtimeWorker(createInMemoryCatalogWorkerRuntime(store));
    const { db, queries } = fakeDatabase();
    const initial = snapshot("https://example.test/table.xlsx");
    initial.schemas[0].tables[0].scanner = { type: "xlsx", options: { header: true } };
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      { workspaceId: "workspace", catalogName: "dataset", ackTimeoutMs: 100 },
      initial,
    );
    try {
      const replacement = structuredClone(initial.schemas[0].tables[0]);
      replacement.scanner.options = { header: true, sheet: "Data" };
      await controller.replaceTable("main", replacement);

      assert.equal(queries.filter((query) => query === "LOAD excel").length, 1);
      assert.ok(
        queries.indexOf("LOAD excel") <
          queries.indexOf("ATTACH 'workspace' AS \"dataset\" (TYPE in_memory_catalog, READ_ONLY)"),
      );
    } finally {
      await controller.close();
    }
  });

  it("rejects ambiguous extension configuration", async () => {
    const { db } = fakeDatabase();
    await assert.rejects(
      () =>
        InMemoryCatalogController.initialize(
          db,
          {},
          {
            workspaceId: "workspace",
            catalogName: "dataset",
            extensionName: "legacy_name",
            extension: { url: "/extensions/catalog.wasm" },
          },
          snapshot(),
        ),
      (error) => error.code === "RC_METADATA_INVALID",
    );
  });

  it("captures each submitted state before queuing and recovers from failed publication", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const actualSession = store.openWorkspaceSession.bind(store);
    const publishedNames = [];
    store.openWorkspaceSession = (...args) => {
      const session = actualSession(...args);
      return {
        ...session,
        async replaceCatalogSnapshot(candidate) {
          await session.replaceCatalogSnapshot(candidate);
          publishedNames.push(candidate.schemas[0].tables[0].name);
        },
      };
    };
    const worker = runtimeWorker(createInMemoryCatalogWorkerRuntime(store));
    const { db } = fakeDatabase();
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      { workspaceId: "workspace", catalogName: "dataset", ackTimeoutMs: 100 },
      snapshot(),
    );
    try {
      const candidate = snapshot();
      candidate.schemas[0].tables[0].name = "first";
      const first = controller.publishSnapshot(candidate);
      candidate.schemas[0].tables[0].name = "second";
      const second = controller.publishSnapshot(candidate);
      candidate.schemas[0].tables[0].name = "not-submitted";
      await Promise.all([first, second]);
      assert.deepEqual(publishedNames, ["table1", "first", "second"]);
      assert.equal(store.currentRevision("workspace"), 3n);
      await assert.rejects(
        controller.publishSnapshot({}),
        (error) => error.code === "RC_METADATA_VERSION",
      );
      await controller.publishSnapshot(snapshot());
      assert.equal(store.currentRevision("workspace"), 4n);
      assert.equal("currentRevision" in controller, false);
    } finally {
      await controller.close();
    }
  });

  it("replaces one table through the dedicated worker operation and captures input before queueing", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const worker = runtimeWorker(createInMemoryCatalogWorkerRuntime(store));
    const { db } = fakeDatabase();
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      { workspaceId: "workspace", catalogName: "dataset", ackTimeoutMs: 100 },
      snapshot(),
    );

    try {
      const candidate = snapshot("https://example.test/table-update").schemas[0].tables[0];
      candidate.snapshot = "snapshot-update";
      const firstFull = snapshot("https://example.test/full-update");
      firstFull.schemas[0].tables[0].snapshot = "snapshot-full-update";
      const fullPublication = controller.publishSnapshot(firstFull);
      const replacement = controller.replaceTable("MAIN", candidate);
      candidate.snapshot = "mutated-after-submit";
      candidate.files[0] = "https://example.test/mutated-after-submit";
      await Promise.all([fullPublication, replacement]);

      assert.equal(store.currentRevision("workspace"), 3n);
      const updated = store.lookupTable("workspace", "3", "main", "table1");
      assert.equal(updated.snapshot, "snapshot-update");
      assert.equal(updated.files[0], "https://example.test/table-update");

      const replacementBeforeFull = snapshot("https://example.test/table-before-full").schemas[0]
        .tables[0];
      replacementBeforeFull.snapshot = "snapshot-before-full";
      const secondReplacement = controller.replaceTable("main", replacementBeforeFull);
      const finalFull = snapshot("https://example.test/final-full");
      finalFull.schemas[0].tables[0].snapshot = "snapshot-final-full";
      const finalPublication = controller.publishSnapshot(finalFull);
      await Promise.all([secondReplacement, finalPublication]);

      assert.equal(store.currentRevision("workspace"), 5n);
      const finalTable = store.lookupTable("workspace", "5", "main", "table1");
      assert.equal(finalTable.snapshot, "snapshot-final-full");
      assert.equal(finalTable.files[0], "https://example.test/final-full");
    } finally {
      await controller.close();
    }
  });

  it("replaces one view through the dedicated worker operation and captures input before queueing", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const worker = runtimeWorker(createInMemoryCatalogWorkerRuntime(store));
    const { db } = fakeDatabase();
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      { workspaceId: "workspace", catalogName: "dataset", ackTimeoutMs: 100 },
      viewSnapshot(),
    );

    try {
      const candidate = { name: "VIEW1", query: "SELECT id FROM table1 WHERE id > 10" };
      const replacement = controller.replaceView("MAIN", candidate);
      candidate.query = "SELECT id FROM table1 WHERE id > 20";
      await replacement;

      assert.equal(
        store.lookupView("workspace", "2", "main", "view1").query,
        "SELECT id FROM table1 WHERE id > 10",
      );
    } finally {
      await controller.close();
    }
  });

  it("closes successfully after publication", async () => {
    const store = new InMemoryCatalogMetadataStore();
    const worker = runtimeWorker(createInMemoryCatalogWorkerRuntime(store));
    const { db } = fakeDatabase();
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      { workspaceId: "workspace", catalogName: "dataset", ackTimeoutMs: 100 },
      snapshot(),
    );

    await controller.close();

    assert.equal(controller.state, "closed");
    assert.equal(store.diagnostics().retained_workspace_snapshot_count, 0);
  });

  it("enters failed_closed, releases local resources, and reports recovery when drop ack times out", async () => {
    const recovery = [];
    const { db, connection } = fakeDatabase();
    const worker = workerWithoutDropAck();
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      {
        workspaceId: "workspace",
        catalogName: "dataset",
        ackTimeoutMs: 50,
        onRecoveryRequired(details) {
          recovery.push(details);
          throw new Error("observer failure");
        },
      },
      snapshot(),
    );

    await assert.rejects(controller.close(), (error) => {
      assert.ok(error instanceof InMemoryCatalogControllerError);
      assert.equal(error.code, "RC_CATALOG_RECOVERY_REQUIRED");
      return true;
    });

    assert.equal(controller.state, "failed_closed");
    assert.equal(connection.closed, true);
    assert.deepEqual(recovery, [{ component: "in_memory_catalog", workspaceId: "workspace" }]);
    await assert.rejects(
      () => controller.publishSnapshot(snapshot()),
      (error) => error.code === "RC_CATALOG_WORKSPACE_CLOSED",
    );
  });
});

function workerWithoutDropAck() {
  const worker = {};
  worker.postMessage = (data, ports) => {
    const port = ports[0];
    port.onmessage = (event) => {
      if (event.data.type === "IN_MEMORY_CATALOG_REPLACE_SNAPSHOT") {
        port.postMessage({
          type: "IN_MEMORY_CATALOG_REPLACE_SNAPSHOT_RESULT",
          request_id: event.data.request_id,
          ok: true,
        });
      }
    };
    port.postMessage({ type: "IN_MEMORY_CATALOG_WORKSPACE_SESSION_OPENED", ok: true });
  };
  return worker;
}
