// The tests intentionally exercise untyped runtime fixtures and source contracts.
// @ts-nocheck
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createDuckDBQueryGate } from "../../src/javascript/in-memory-catalog-query-gate";

await import("../../src/javascript/in-memory-catalog-metadata-store");
await import("../../src/javascript/in-memory-catalog-worker-runtime");
const { createInMemoryCatalogWorker, InMemoryCatalogController, InMemoryCatalogControllerError } =
  await import("../../src/javascript/in-memory-catalog-controller");

const { InMemoryCatalogMetadataStore } = globalThis.DuckDBInMemoryCatalogMetadata;
const { createInMemoryCatalogWorkerRuntime: createRuntime } =
  globalThis.DuckDBInMemoryCatalogWorkerRuntime;
const fakeConnections = new Map();
let nextFakeConnection = 100;

function createInMemoryCatalogWorkerRuntime(store, gate) {
  if (!gate) {
    gate = createDuckDBQueryGate(({ data: request }) => {
      const connection = fakeConnections.get(request.data[0]);
      void connection.query(request.data[1]).then(
        () => gate.observeResponse({ requestId: request.messageId, type: "QUERY_RESULT" }),
        (error) =>
          gate.observeResponse({
            requestId: request.messageId,
            type: "ERROR",
            data: { message: error.message },
          }),
      );
    });
  }
  return createRuntime(store, gate);
}

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
  const id = ++nextFakeConnection;
  const queries = [];
  const connection = {
    closed: false,
    useUnsafe(callback) {
      return callback(undefined, id);
    },
    async query(sql) {
      queries.push(sql);
    },
    async close() {
      this.closed = true;
    },
  };
  fakeConnections.set(id, connection);
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

function gatedDatabase() {
  const store = new InMemoryCatalogMetadataStore();
  const waiters = new Map();
  const held = new Map();
  const queries = [];
  let messageId = 0;
  let connectionId = 0;
  const post = (response) => {
    const waiter = waiters.get(response.requestId);
    if (!waiter) throw new Error("Unexpected public reply");
    waiters.delete(response.requestId);
    if (response.type === "ERROR")
      waiter.reject(Object.assign(new Error(response.data.message), { code: response.data.code }));
    else waiter.resolve(response.data);
  };
  const reply = (request, type = "QUERY_RESULT", data = []) => {
    const response = { requestId: request.messageId, type, data };
    if (gate.observeResponse(response)) post(response);
  };
  const gate = createDuckDBQueryGate(({ data: request }) => {
    queries.push(request);
    if (request.type === "RUN_QUERY" && request.data[1] === "slow")
      held.set(request.data[0], request);
    else
      queueMicrotask(() => reply(request, request.type === "DISCONNECT" ? "OK" : "QUERY_RESULT"));
    // Deliberately return void: completion must follow the protocol reply.
  }, post);
  const send = (type, data) =>
    new Promise((resolve, reject) => {
      const id = ++messageId;
      waiters.set(id, { resolve, reject });
      gate.handleMessage({ data: { messageId: id, type, data } });
    });
  const db = {
    async connect() {
      const id = ++connectionId;
      return {
        useUnsafe: (callback) => callback(db, id),
        query: (sql) => send("RUN_QUERY", [id, sql]),
        close: () => send("DISCONNECT", id),
      };
    },
  };
  return {
    db,
    store,
    gate,
    queries,
    held,
    reply,
    send,
    worker: runtimeWorker(createInMemoryCatalogWorkerRuntime(store, gate)),
  };
}

describe("InMemoryCatalogController", () => {
  it("protects ordinary connections across the shared Worker and loads scoped scanner extensions", async () => {
    const f = gatedDatabase();
    const catalog = await InMemoryCatalogController.initialize(
      f.db,
      f.worker,
      { workspaceId: "workspace", catalogName: "dataset" },
      snapshot(),
    );
    const second = await f.db.connect();
    const firstRead = catalog.connection.query("slow");
    const entered = deferred();
    const finish = deferred();
    const update = catalog.update(async (scope) => {
      entered.resolve();
      await finish.promise;
      const table = snapshot("https://example.test/new.json").schemas[0].tables[0];
      table.snapshot = "new";
      table.scanner = { type: "json", options: {} };
      await scope.replaceTable("main", table);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      f.queries.some((r) => r.data?.[1] === "LOAD json"),
      false,
    );
    f.reply(f.held.get(1));
    await firstRead;
    await entered.promise;
    const nextRead = second.query("after update");
    assert.equal(
      f.queries.some((r) => r.data?.[1] === "after update"),
      false,
    );
    finish.resolve();
    await update;
    await nextRead;
    const sql = f.queries.filter((r) => r.type === "RUN_QUERY").map((r) => r.data[1]);
    assert.ok(sql.indexOf("LOAD json") < sql.indexOf("after update"));
    await second.close();
    await catalog.close();
  });

  it("waits for an existing stream to disconnect before invoking the host callback", async () => {
    const f = gatedDatabase();
    const catalog = await InMemoryCatalogController.initialize(
      f.db,
      f.worker,
      { workspaceId: "workspace", catalogName: "dataset" },
      snapshot(),
    );
    // Reserve a streaming request in the actual gate through the normal DuckDB protocol.
    await f.send("SEND_PREPARED", [2, 1, []]);
    let called = false;
    const update = catalog.update(() => {
      called = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(called, false);
    await f.send("DISCONNECT", 2);
    await update;
    assert.equal(called, true);
    assert.equal(catalog.state, "active");
    await catalog.close();
  });

  it("times out waiting for an abandoned stream without invoking the callback or cancelling the stream", async () => {
    const f = gatedDatabase();
    const catalog = await InMemoryCatalogController.initialize(
      f.db,
      f.worker,
      { workspaceId: "workspace", catalogName: "dataset", ackTimeoutMs: 20 },
      snapshot(),
    );
    await f.send("SEND_PREPARED", [2, 1, []]);
    let called = false;
    await assert.rejects(
      catalog.update(() => {
        called = true;
      }),
      { code: "RC_REMOTE_IO" },
    );
    assert.equal(called, false);
    assert.equal(catalog.state, "active");
    assert.equal(
      f.queries.some((r) => r.type === "CANCEL_PENDING_QUERY"),
      false,
    );
    await catalog.connection.query("after timeout");
    await f.send("DISCONNECT", 2);
    await catalog.update(() => "retry");
    await catalog.close();
  });

  it("cancels timed-out acquisition and permits retry after the active read finishes", async () => {
    const f = gatedDatabase();
    const catalog = await InMemoryCatalogController.initialize(
      f.db,
      f.worker,
      { workspaceId: "workspace", catalogName: "dataset", ackTimeoutMs: 20 },
      snapshot(),
    );
    const read = catalog.connection.query("slow");
    let called = false;
    await assert.rejects(
      catalog.update(() => {
        called = true;
      }),
      { code: "RC_REMOTE_IO" },
    );
    assert.equal(called, false);
    assert.equal(catalog.state, "active");
    f.reply(f.held.get(1));
    await read;
    await catalog.update(() => "no-op");
    await catalog.connection.query("after cancellation");
    await catalog.close();
  });

  it("fails closed for ordinary queries on every connection after a host exception", async () => {
    const f = gatedDatabase();
    const catalog = await InMemoryCatalogController.initialize(
      f.db,
      f.worker,
      { workspaceId: "workspace", catalogName: "dataset" },
      snapshot(),
    );
    const second = await f.db.connect();
    await assert.rejects(
      catalog.update(() => {
        throw new Error("upload failed");
      }),
      /upload failed/,
    );
    await assert.rejects(catalog.connection.query("blocked"), /RC_CATALOG_RECOVERY_REQUIRED/);
    await assert.rejects(second.query("also blocked"), /RC_CATALOG_RECOVERY_REQUIRED/);
    await second.close();
    await catalog.close();
  });

  it("rejects initialization on custom connections without an identifier accessor", async () => {
    const { db, connection } = fakeDatabase();
    delete connection.useUnsafe;
    await assert.rejects(
      InMemoryCatalogController.initialize(
        db,
        runtimeWorker(createInMemoryCatalogWorkerRuntime(new InMemoryCatalogMetadataStore())),
        { workspaceId: "workspace", catalogName: "dataset" },
        snapshot(),
      ),
      { code: "RC_CATALOG_WORKER_GATE_UNAVAILABLE" },
    );
    assert.equal(connection.closed, true);
  });

  it("drains unawaited scoped publication before queued reads and expires the scope", async () => {
    const f = gatedDatabase();
    const controller = await InMemoryCatalogController.initialize(
      f.db,
      f.worker,
      { workspaceId: "workspace", catalogName: "dataset" },
      snapshot(),
    );
    const started = deferred();
    const finish = deferred();
    let scope;
    const exclusive = controller.update(async (update) => {
      scope = update;
      started.resolve();
      await finish.promise;
      const table = snapshot().schemas[0].tables[0];
      table.snapshot = "new-version";
      void update.replaceTable("main", table);
      table.snapshot = "not-submitted";
      return "updated";
    });
    await started.promise;
    const read = controller.connection.query("after publication");
    assert.equal(
      f.queries.some((r) => r.data?.[1] === "after publication"),
      false,
    );
    assert.equal("publishSnapshot" in controller, false);
    assert.equal("replaceTable" in controller, false);
    assert.equal("replaceView" in controller, false);
    const close = controller.close();
    finish.resolve();
    assert.equal(await exclusive, "updated");
    await read;
    assert.equal(
      f.store.lookupTable(
        "workspace",
        f.store.currentRevision("workspace").toString(),
        "main",
        "table1",
      ).snapshot,
      "new-version",
    );
    await close;
    await assert.rejects(scope.publishSnapshot(snapshot()), { code: "RC_CATALOG_UPDATE_SCOPE" });
  });

  it("fails closed on a host failure and blocks queued work even while close drains", async () => {
    const f = gatedDatabase();
    const { db, queries } = f;
    const recovery = [];
    const controller = await InMemoryCatalogController.initialize(
      db,
      f.worker,
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
    const update = controller.update(async () => {
      started.resolve();
      await fail.promise;
      throw originalError;
    });
    const updateRejected = assert.rejects(update, (error) => error === originalError);
    const metadataRejected = assert.rejects(
      controller.update((update) => update.publishSnapshot(snapshot())),
      (error) => error.code === "RC_CATALOG_RECOVERY_REQUIRED",
    );
    await started.promise;
    const queryRejected = assert.rejects(
      controller.connection.query("must not run"),
      (error) => error.code === "RC_CATALOG_RECOVERY_REQUIRED",
    );
    const close = controller.close();
    fail.resolve();
    await Promise.all([updateRejected, queryRejected, metadataRejected, close]);
    assert.equal(
      queries.some((r) => r.data?.[1] === "must not run"),
      false,
    );
    assert.equal(recovery.length, 1);
    await assert.rejects(
      controller.connection.query("still blocked"),
      (error) => error.code === "RC_CATALOG_RECOVERY_REQUIRED",
    );
    assert.equal(recovery.length, 1);
  });

  it("keeps scoped metadata failures sticky even when the callback catches them", async () => {
    const f = gatedDatabase();
    const { db } = f;
    const controller = await InMemoryCatalogController.initialize(
      db,
      f.worker,
      { workspaceId: "workspace", catalogName: "dataset" },
      snapshot(),
    );
    try {
      await assert.rejects(
        controller.update(async (update) => {
          await assert.rejects(
            update.publishSnapshot({}),
            (error) => error.code === "RC_METADATA_VERSION",
          );
        }),
        (error) => error.code === "RC_METADATA_VERSION",
      );
      assert.equal(controller.state, "failed_closed");
      await assert.rejects(
        controller.connection.query("blocked"),
        (error) => error.code === "RC_CATALOG_RECOVERY_REQUIRED",
      );
    } finally {
      await controller.close();
    }
  });

  it("resumes queued reads after a no-op update and expires its scope", async () => {
    const f = gatedDatabase();
    const { db, queries, store } = f;
    const controller = await InMemoryCatalogController.initialize(
      db,
      f.worker,
      { workspaceId: "workspace", catalogName: "dataset" },
      snapshot(),
    );
    try {
      let scope;
      const finish = deferred();
      const started = deferred();
      const exclusive = controller.update(async (update) => {
        scope = update;
        started.resolve();
        await finish.promise;
        return "unchanged";
      });
      await started.promise;
      const read = controller.connection.query("read after no-op");
      await Promise.resolve();
      assert.equal(
        queries.some((r) => r.data?.[1] === "read after no-op"),
        false,
      );
      finish.resolve();
      assert.equal(await exclusive, "unchanged");
      await read;
      assert.equal(
        queries.some((r) => r.data?.[1] === "read after no-op"),
        true,
      );
      assert.equal(store.currentRevision("workspace"), 1n);
      await assert.rejects(
        scope.replaceTable("main", snapshot().schemas[0].tables[0]),
        (error) => error.code === "RC_CATALOG_UPDATE_SCOPE",
      );
      assert.equal(controller.state, "active");
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
      const bad = assert.rejects(controller.connection.query("bad query"), /SQL error/);
      const good = controller.connection.query("good query");
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

    await controller.update((update) =>
      update.publishSnapshot(snapshot("https://example.test/revision-2")),
    );
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
      await controller.update((update) => update.publishSnapshot(jsonSnapshot));

      const replacement = structuredClone(jsonSnapshot.schemas[0].tables[0]);
      replacement.columns = [{ name: "payload", type: "JSON", nullable: true }];
      await controller.update((update) => update.replaceTable("main", replacement));

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
      await controller.update((update) => update.replaceTable("main", replacement));

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

  it("captures scoped publications before queuing and fails closed after invalid publication", async () => {
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
      await controller.update(async (update) => {
        candidate.schemas[0].tables[0].name = "first";
        const first = update.publishSnapshot(candidate);
        candidate.schemas[0].tables[0].name = "second";
        const second = update.publishSnapshot(candidate);
        candidate.schemas[0].tables[0].name = "not-submitted";
        await Promise.all([first, second]);
      });
      assert.deepEqual(publishedNames, ["table1", "first", "second"]);
      assert.equal(store.currentRevision("workspace"), 3n);
      await assert.rejects(
        controller.update((update) => update.publishSnapshot({})),
        (error) => error.code === "RC_METADATA_VERSION",
      );
      await assert.rejects(
        controller.update((update) => update.publishSnapshot(snapshot())),
        { code: "RC_CATALOG_RECOVERY_REQUIRED" },
      );
      assert.equal(store.currentRevision("workspace"), 3n);
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
      const fullPublication = controller.update((update) => update.publishSnapshot(firstFull));
      const replacement = controller.update((update) => {
        const operation = update.replaceTable("MAIN", candidate);
        candidate.snapshot = "mutated-after-submit";
        candidate.files[0] = "https://example.test/mutated-after-submit";
        return operation;
      });
      await Promise.all([fullPublication, replacement]);

      assert.equal(store.currentRevision("workspace"), 3n);
      const updated = store.lookupTable("workspace", "3", "main", "table1");
      assert.equal(updated.snapshot, "snapshot-update");
      assert.equal(updated.files[0], "https://example.test/table-update");

      const replacementBeforeFull = snapshot("https://example.test/table-before-full").schemas[0]
        .tables[0];
      replacementBeforeFull.snapshot = "snapshot-before-full";
      const secondReplacement = controller.update((update) =>
        update.replaceTable("main", replacementBeforeFull),
      );
      const finalFull = snapshot("https://example.test/final-full");
      finalFull.schemas[0].tables[0].snapshot = "snapshot-final-full";
      const finalPublication = controller.update((update) => update.publishSnapshot(finalFull));
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
      const replacement = controller.update((update) => {
        const operation = update.replaceView("MAIN", candidate);
        candidate.query = "SELECT id FROM table1 WHERE id > 20";
        return operation;
      });
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
      () => controller.update((update) => update.publishSnapshot(snapshot())),
      (error) => error.code === "RC_CATALOG_WORKSPACE_CLOSED",
    );
  });
});

function workerWithoutDropAck() {
  const worker = {};
  worker.postMessage = (data, ports) => {
    const port = ports[0];
    port.onmessage = (event) => {
      if (event.data.type !== "IN_MEMORY_CATALOG_DROP_WORKSPACE") {
        port.postMessage({
          type: `${event.data.type}_RESULT`,
          request_id: event.data.request_id,
          ok: true,
        });
      }
    };
    port.postMessage({ type: "IN_MEMORY_CATALOG_WORKSPACE_SESSION_OPENED", ok: true });
  };
  return worker;
}
