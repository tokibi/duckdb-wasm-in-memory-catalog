/** A column declared in a catalog snapshot. */
export interface CatalogColumn {
  name: string;
  /** A supported DuckDB logical type, such as `BIGINT` or `STRUCT(id BIGINT)`. */
  type: string;
  nullable: boolean;
}

export type ParquetScannerOptions = Record<string, never>;

export interface CsvScannerOptions {
  auto_detect?: boolean;
  header?: boolean;
  delimiter?: string;
  quote?: string;
  escape?: string;
  comment?: string;
  skip?: number;
  nullstr?: string | string[];
  dateformat?: string;
  timestampformat?: string;
  compression?: string;
  ignore_errors?: boolean;
  null_padding?: boolean;
  allow_quoted_nulls?: boolean;
  buffer_size?: number;
  decimal_separator?: string;
  encoding?: string;
  force_not_null?: string[];
  max_line_size?: number;
  new_line?: string;
  parallel?: boolean;
  sample_size?: number;
  strict_mode?: boolean;
  thousands?: string;
}

export interface JsonScannerOptions {
  format?: "auto" | "array" | "newline_delimited" | "unstructured";
  compression?: string;
  records?: "auto" | "true" | "false";
  ignore_errors?: boolean;
  maximum_object_size?: number;
  dateformat?: string;
  timestampformat?: string;
}

export interface XlsxScannerOptions {
  header?: boolean;
  sheet?: string;
  range?: string;
  all_varchar?: boolean;
  ignore_errors?: boolean;
  stop_at_empty?: boolean;
  empty_as_varchar?: boolean;
}

export type CatalogScanner =
  | { type: "parquet"; options: ParquetScannerOptions }
  | { type: "csv"; options: CsvScannerOptions }
  | { type: "json"; options: JsonScannerOptions }
  | { type: "xlsx"; options: XlsxScannerOptions };

export interface CatalogTable {
  name: string;
  snapshot: string;
  scanner: CatalogScanner;
  columns: CatalogColumn[];
  files: string[];
}

export interface CatalogView {
  name: string;
  query: string;
}

export interface CatalogSchema {
  name: string;
  tables: CatalogTable[];
  views?: CatalogView[];
}

/** Format 1 is the currently supported catalog snapshot wire format. */
export interface CatalogSnapshot {
  format_version: 1;
  schemas: CatalogSchema[];
}

export interface CatalogExtensionOptions {
  /** Extension name, defaulting to `in_memory_catalog`. */
  name?: string;
  /** Direct URL to the extension Wasm file. */
  url?: string;
  /** Extension repository URL used with `INSTALL`. */
  repository?: string;
}

export interface InMemoryCatalogControllerOptions {
  workspaceId: string;
  catalogName: string;
  extension?: CatalogExtensionOptions;
  /** Backward-compatible shorthand for `extension.name`. */
  extensionName?: string;
  ackTimeoutMs?: number;
  onRecoveryRequired?: (details: CatalogRecoveryDetails) => void;
}

export interface CatalogRecoveryDetails {
  component: "in_memory_catalog";
  workspaceId: string;
}

/** Metadata operations available only inside an exclusive update callback. */
export interface CatalogExclusiveUpdate {
  publishSnapshot(snapshot: CatalogSnapshot): Promise<void>;
  replaceTable(schemaName: string, table: CatalogTable): Promise<void>;
  replaceView(schemaName: string, view: CatalogView): Promise<void>;
}

export interface CatalogDiagnostics {
  active_workspace_session_count: number;
  retained_workspace_snapshot_count: number;
  retained_catalog_revision_state: number;
  full_lookup_count: number;
  uri_descriptor_transfer_count: number;
}

/** The subset of a DuckDB-Wasm connection used and exposed by the controller. */
export interface CatalogConnectionLike {
  query(sql: string): Promise<unknown>;
  close(): Promise<void>;
  /** DuckDB-Wasm's connection identifier accessor, needed for Worker-scoped updates. */
  useUnsafe?<R>(callback: (bindings: unknown, connectionId: number) => R): R;
}

/** The subset of DuckDB-Wasm used to open the managed connection. */
export interface CatalogDatabase<
  TConnection extends CatalogConnectionLike = CatalogConnectionLike,
> {
  connect(): Promise<TConnection>;
}

/** A Worker that can receive the transferred workspace MessagePort. */
export interface CatalogWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export class InMemoryCatalogControllerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InMemoryCatalogControllerError";
    this.code = code;
  }
}

/**
 * Create the classic Worker used by both DuckDB-Wasm and the catalog runtime.
 *
 * The catalog entrypoint intentionally does not bundle or choose a DuckDB-Wasm
 * Worker. The caller supplies the Worker that matches its selected DuckDB-Wasm
 * bundle; the entrypoint loads that script in the same Dedicated Worker so the
 * synchronous extension bridge remains available.
 */
export interface WorkerCreationOptions {
  duckdbWorker: string | URL;
  workerUrl?: string | URL;
}

interface NormalizedExtensionOptions {
  name: string;
  url?: string;
  repository?: string;
}

interface NormalizedControllerOptions {
  workspaceId: string;
  catalogName: string;
  extension: NormalizedExtensionOptions;
  ackTimeoutMs: number;
  onRecoveryRequired?: (details: CatalogRecoveryDetails) => void;
}

interface WorkspaceReply {
  type?: string;
  request_id?: string;
  ok?: unknown;
  code?: unknown;
  message?: unknown;
  diagnostics?: CatalogDiagnostics;
  [key: string]: unknown;
}

interface WorkspaceWaiter {
  type: string;
  requestId: string | undefined;
  resolve: (reply: WorkspaceReply) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export function createInMemoryCatalogWorker(options?: WorkerCreationOptions): Worker {
  const { duckdbWorker, workerUrl } = options ?? {};
  const duckdbWorkerUrl = requireWorkerUrl(duckdbWorker, "duckdbWorker");
  const catalogWorkerUrl = requireWorkerUrl(
    workerUrl === undefined ? new URL("./in-memory-catalog-worker.js", import.meta.url) : workerUrl,
    "workerUrl",
  );
  catalogWorkerUrl.searchParams.set("duckdbWorker", duckdbWorkerUrl.href);

  if (typeof globalThis.Worker !== "function") {
    throw new InMemoryCatalogControllerError(
      "RC_RUNTIME_UNAVAILABLE",
      "The Worker API is required to create an In-Memory Catalog Worker",
    );
  }
  return new globalThis.Worker(catalogWorkerUrl, { type: "classic" });
}

export class InMemoryCatalogController<
  TConnection extends CatalogConnectionLike = CatalogConnectionLike,
> {
  #connection: TConnection;
  #session: WorkspaceSessionClient;
  #workspaceId: string;
  #catalogName: string;
  #onRecoveryRequired: ((details: CatalogRecoveryDetails) => void) | undefined;
  #pending: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;
  #attached = false;
  #state: "active" | "closing" | "closed" | "failed_closed" = "active";
  #recoveryReported = false;
  #loadedExtensions = new Set<string>();
  #exclusiveActive = false;
  #exclusiveFailed = false;
  #connectionId: number | undefined;
  #exclusiveToken: string | undefined;
  #updateSequence = 0;

  static async initialize<TConnection extends CatalogConnectionLike>(
    db: CatalogDatabase<TConnection>,
    worker: CatalogWorkerLike,
    options: InMemoryCatalogControllerOptions,
    initialSnapshot: CatalogSnapshot,
  ): Promise<InMemoryCatalogController<TConnection>> {
    const normalized = normalizeOptions(options);
    const connection = await db.connect();
    let controller: InMemoryCatalogController<TConnection> | undefined;
    try {
      await connection.query("LOAD parquet");
      if (normalized.extension.repository !== undefined) {
        await connection.query(
          `INSTALL ${quote(normalized.extension.name)} FROM ${quote(normalized.extension.repository)}`,
        );
        await connection.query(`LOAD ${quote(normalized.extension.name)}`);
      } else {
        await connection.query(
          `LOAD ${quote(normalized.extension.url ?? normalized.extension.name)}`,
        );
      }
      const session = await WorkspaceSessionClient.open(
        worker,
        normalized.workspaceId,
        normalized.ackTimeoutMs,
        connection.useUnsafe?.((_bindings, connectionId) => connectionId),
      );
      controller = new InMemoryCatalogController(connection, session, normalized);
      await controller.publishSnapshot(initialSnapshot);
      await connection.query(
        `ATTACH ${quote(normalized.workspaceId)} AS ${quoteIdentifier(normalized.catalogName)} ` +
          "(TYPE in_memory_catalog, READ_ONLY)",
      );
      controller.#attached = true;
      return controller;
    } catch (error) {
      if (controller) {
        try {
          await controller.close();
        } catch {
          // Recovery notification is emitted by close; preserve the initialization error.
        }
      } else {
        await connection.close();
      }
      throw error;
    }
  }

  private constructor(
    connection: TConnection,
    session: WorkspaceSessionClient,
    options: NormalizedControllerOptions,
  ) {
    this.#connection = connection;
    this.#session = session;
    this.#workspaceId = options.workspaceId;
    this.#catalogName = options.catalogName;
    this.#onRecoveryRequired = options.onRecoveryRequired;
    this.#connectionId = connection.useUnsafe?.((_bindings, connectionId) => connectionId);
  }

  /** Normal DuckDB connection. The shared Worker protects its materialized queries. */
  // Public API used by the demo; Fallow cannot resolve initialize()'s generic result.
  // fallow-ignore-next-line unused-class-member
  get connection(): TConnection {
    return this.#connection;
  }

  // Public API exercised by the controller lifecycle tests.
  // fallow-ignore-next-line unused-class-member
  get state(): "active" | "closing" | "closed" | "failed_closed" {
    return this.#state;
  }

  /** Execute a fully materialized query through the controller's operation queue. */
  // Public API; Fallow does not resolve calls through initialize()'s generic result.
  // fallow-ignore-next-line unused-class-member
  query(sql: string): Promise<Awaited<ReturnType<TConnection["query"]>>> {
    return this.#enqueue(() => this.#connection.query(sql)) as Promise<
      Awaited<ReturnType<TConnection["query"]>>
    >;
  }

  /**
   * Wait for materialized queries on the shared Worker, then exclude new starts while the host updates files and
   * publishes metadata through the supplied scope. Failures require closing and
   * recreating the Worker after the host repairs its files and metadata.
   * Do not query DuckDB from the callback; use only the scoped metadata operations.
   */
  // Public API for host applications; exercised by the controller concurrency tests.
  // fallow-ignore-next-line unused-class-member
  withExclusiveUpdate<T>(callback: (update: CatalogExclusiveUpdate) => T | Promise<T>): Promise<T> {
    if (typeof callback !== "function") {
      return Promise.reject(
        new InMemoryCatalogControllerError("RC_METADATA_INVALID", "An update callback is required"),
      );
    }
    return this.#enqueue(async () => {
      await this.#acquireUpdate();
      this.#exclusiveActive = true;
      let accepting = true;
      let pending = Promise.resolve();
      let failed = false;
      let failure: unknown;
      const recordFailure = (error: unknown): void => {
        if (failed) return;
        failed = true;
        failure = error;
      };
      const submit = <V>(value: V, apply: (captured: V) => Promise<void>): Promise<void> => {
        if (!accepting) {
          return Promise.reject(
            new InMemoryCatalogControllerError(
              "RC_CATALOG_UPDATE_SCOPE",
              "The exclusive update scope has expired",
            ),
          );
        }
        let captured!: V;
        try {
          captured = structuredClone(value);
        } catch (error) {
          recordFailure(error);
        }
        const operation = pending.then(async () => {
          if (failed) throw failure;
          await apply(captured);
        });
        // Observe every submitted operation, including ones the callback does not await.
        pending = operation.catch(recordFailure);
        return operation;
      };
      const update: CatalogExclusiveUpdate = {
        publishSnapshot: (snapshot) =>
          submit(snapshot, (value) => this.#publishSnapshot(value, true)),
        replaceTable: (schemaName, table) =>
          submit(table, (value) => this.#replaceTable(schemaName, value, true)),
        replaceView: (schemaName, view) =>
          submit(view, (value) => this.#replaceView(schemaName, value, true)),
      };
      try {
        let result!: T;
        try {
          result = await callback(update);
        } catch (error) {
          recordFailure(error);
        } finally {
          accepting = false;
        }
        await pending;
        if (failed) throw failure;
        await this.#finishUpdate(false);
        return result;
      } catch (error) {
        this.#exclusiveFailed = true;
        this.#state = "failed_closed";
        try {
          await this.#finishUpdate(true);
        } catch {
          // Preserve the original failure; recovery requires replacing the Worker.
        }
        this.#reportRecoveryRequired();
        throw error;
      } finally {
        this.#exclusiveActive = false;
      }
    });
  }

  publishSnapshot(snapshot: CatalogSnapshot): Promise<void> {
    return this.#publishSnapshot(snapshot);
  }

  #publishSnapshot(snapshot: CatalogSnapshot, scoped = false): Promise<void> {
    const stateError = this.#metadataStateError(scoped);
    if (stateError) return Promise.reject(stateError);
    let submittedSnapshot: CatalogSnapshot;
    try {
      submittedSnapshot = structuredClone(snapshot);
    } catch {
      return Promise.reject(
        new InMemoryCatalogControllerError(
          "RC_METADATA_INVALID",
          "Catalog snapshot must be structured-cloneable",
        ),
      );
    }
    const operation = async () => {
      await this.#ensureRequiredExtensions(submittedSnapshot, scoped);
      const result = await this.#session.request(
        "IN_MEMORY_CATALOG_REPLACE_SNAPSHOT",
        "IN_MEMORY_CATALOG_REPLACE_SNAPSHOT_RESULT",
        { snapshot: submittedSnapshot, ...(scoped ? { update_token: this.#exclusiveToken } : {}) },
      );
      requireSuccessfulResult(result, "Catalog publication failed");
    };
    return this.#submitMetadata(operation, scoped);
  }

  // Public API exercised by the table replacement tests and browser example.
  // fallow-ignore-next-line unused-class-member
  replaceTable(schemaName: string, table: CatalogTable): Promise<void> {
    return this.#replaceTable(schemaName, table);
  }

  #replaceTable(schemaName: string, table: CatalogTable, scoped = false): Promise<void> {
    let submittedSchemaName: string;
    let submittedTable: CatalogTable;
    try {
      ({ schemaName: submittedSchemaName, value: submittedTable } = this.#captureNamedMetadata(
        schemaName,
        table,
        "table",
        scoped,
      ));
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = async () => {
      await this.#ensureRequiredExtensions(submittedTable, scoped);
      const result = await this.#session.request(
        "IN_MEMORY_CATALOG_REPLACE_TABLE",
        "IN_MEMORY_CATALOG_REPLACE_TABLE_RESULT",
        {
          schema_name: submittedSchemaName,
          table: submittedTable,
          ...(scoped ? { update_token: this.#exclusiveToken } : {}),
        },
      );
      requireSuccessfulResult(result, "Catalog table replacement failed");
    };
    return this.#submitMetadata(operation, scoped);
  }

  // Public API exercised by the view replacement tests.
  // fallow-ignore-next-line unused-class-member
  replaceView(schemaName: string, view: CatalogView): Promise<void> {
    return this.#replaceView(schemaName, view);
  }

  #replaceView(schemaName: string, view: CatalogView, scoped = false): Promise<void> {
    let submittedSchemaName: string;
    let submittedView: CatalogView;
    try {
      ({ schemaName: submittedSchemaName, value: submittedView } = this.#captureNamedMetadata(
        schemaName,
        view,
        "view",
        scoped,
      ));
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = async () => {
      const result = await this.#session.request(
        "IN_MEMORY_CATALOG_REPLACE_VIEW",
        "IN_MEMORY_CATALOG_REPLACE_VIEW_RESULT",
        {
          schema_name: submittedSchemaName,
          view: submittedView,
          ...(scoped ? { update_token: this.#exclusiveToken } : {}),
        },
      );
      requireSuccessfulResult(result, "Catalog view replacement failed");
    };
    return this.#submitMetadata(operation, scoped);
  }

  // Public API used by the demo; Fallow cannot resolve initialize()'s generic result.
  // fallow-ignore-next-line unused-class-member
  diagnostics(): Promise<CatalogDiagnostics> {
    if (this.#state !== "active") {
      return Promise.reject(
        new InMemoryCatalogControllerError(
          "RC_CATALOG_WORKSPACE_CLOSED",
          "In-Memory Catalog workspace controller is closed",
        ),
      );
    }
    return this.#enqueue(async () => {
      const result = await this.#session.request(
        "IN_MEMORY_CATALOG_GET_DIAGNOSTICS",
        "IN_MEMORY_CATALOG_GET_DIAGNOSTICS_RESULT",
      );
      requireSuccessfulResult(result, "Catalog diagnostics failed");
      return result.diagnostics as CatalogDiagnostics;
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#state = "closing";
    this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  #metadataStateError(scoped: boolean): InMemoryCatalogControllerError | undefined {
    if (scoped || this.#state === "active") return undefined;
    return new InMemoryCatalogControllerError(
      "RC_CATALOG_WORKSPACE_CLOSED",
      "In-Memory Catalog workspace controller is closed",
    );
  }

  #captureNamedMetadata<T>(
    schemaName: string,
    value: T,
    kind: "table" | "view",
    scoped: boolean,
  ): { schemaName: string; value: T } {
    const stateError = this.#metadataStateError(scoped);
    if (stateError) throw stateError;
    const capturedName = requireName(schemaName, "schemaName");
    try {
      return { schemaName: capturedName, value: structuredClone(value) };
    } catch {
      throw new InMemoryCatalogControllerError(
        "RC_METADATA_INVALID",
        `Catalog ${kind} must be structured-cloneable`,
      );
    }
  }

  async #acquireUpdate(): Promise<void> {
    if (!Number.isSafeInteger(this.#connectionId)) {
      throw new InMemoryCatalogControllerError(
        "RC_CATALOG_WORKER_GATE_UNAVAILABLE",
        "Exclusive updates require the DuckDB-Wasm connection useUnsafe identifier accessor",
      );
    }
    const token = `update-${++this.#updateSequence}`;
    try {
      const result = await this.#session.request(
        "IN_MEMORY_CATALOG_ACQUIRE_UPDATE",
        "IN_MEMORY_CATALOG_ACQUIRE_UPDATE_RESULT",
        { update_token: token },
      );
      requireSuccessfulResult(result, "Could not acquire the Worker update gate");
      this.#exclusiveToken = token;
    } catch (error) {
      if (
        error instanceof InMemoryCatalogControllerError &&
        error.code === "RC_CATALOG_RECOVERY_REQUIRED"
      ) {
        this.#exclusiveFailed = true;
        this.#state = "failed_closed";
        this.#reportRecoveryRequired();
        throw error;
      }
      // A timed-out acquire may still receive a late grant. Cancel it on the same
      // ordered port before allowing another attempt; never invoke the host callback.
      try {
        const result = await this.#session.request(
          "IN_MEMORY_CATALOG_CANCEL_UPDATE",
          "IN_MEMORY_CATALOG_CANCEL_UPDATE_RESULT",
          { update_token: token },
        );
        requireSuccessfulResult(result, "Could not cancel the Worker gate acquisition");
      } catch {
        this.#exclusiveFailed = true;
        this.#state = "failed_closed";
        this.#reportRecoveryRequired();
      }
      throw error;
    }
  }

  async #finishUpdate(failed: boolean): Promise<void> {
    if (!this.#exclusiveToken) return;
    const type = failed ? "IN_MEMORY_CATALOG_FAIL_UPDATE" : "IN_MEMORY_CATALOG_RELEASE_UPDATE";
    const result = await this.#session.request(type, `${type}_RESULT`, {
      update_token: this.#exclusiveToken,
    });
    requireSuccessfulResult(result, "Could not release the Worker update gate");
    this.#exclusiveToken = undefined;
  }

  #submitMetadata(operation: () => Promise<void>, scoped: boolean): Promise<void> {
    if (scoped) return operation();
    if (this.#exclusiveActive) {
      return Promise.reject(
        new InMemoryCatalogControllerError(
          "RC_CATALOG_UPDATE_SCOPE",
          "Use the supplied update scope while an exclusive update is running",
        ),
      );
    }
    return this.#enqueue(operation);
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.#exclusiveFailed) return Promise.reject(this.#exclusiveRecoveryError());
    if (this.#state !== "active") {
      return Promise.reject(
        new InMemoryCatalogControllerError(
          "RC_CATALOG_WORKSPACE_CLOSED",
          "In-Memory Catalog workspace controller is closed",
        ),
      );
    }
    const operation = this.#pending.then(() => {
      // Accepted work may drain during close, but must never run after a failed update.
      if (this.#exclusiveFailed) throw this.#exclusiveRecoveryError();
      return run();
    });
    this.#pending = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  #exclusiveRecoveryError(): InMemoryCatalogControllerError {
    return new InMemoryCatalogControllerError(
      "RC_CATALOG_RECOVERY_REQUIRED",
      "An exclusive update failed; repair the files and metadata, then recreate the DuckDB Worker",
    );
  }

  async #performClose(): Promise<void> {
    await this.#pending;
    let failure: InMemoryCatalogControllerError | undefined;
    try {
      if (this.#attached && !this.#exclusiveFailed) {
        await this.#connection.query(`DETACH ${quoteIdentifier(this.#catalogName)}`);
        this.#attached = false;
      }
      const result = await this.#session.request(
        "IN_MEMORY_CATALOG_DROP_WORKSPACE",
        "IN_MEMORY_CATALOG_DROP_WORKSPACE_RESULT",
      );
      requireSuccessfulResult(result, "Catalog workspace drop failed");
      this.#state = "closed";
    } catch (error) {
      this.#state = "failed_closed";
      this.#reportRecoveryRequired();
      failure = new InMemoryCatalogControllerError(
        "RC_CATALOG_RECOVERY_REQUIRED",
        error instanceof Error ? error.message : "Catalog workspace close result is unknown",
      );
    } finally {
      this.#session.close();
      try {
        await this.#connection.close();
      } catch (error) {
        if (!failure) {
          this.#state = "failed_closed";
          this.#reportRecoveryRequired();
          failure = new InMemoryCatalogControllerError(
            "RC_CATALOG_RECOVERY_REQUIRED",
            error instanceof Error ? error.message : "Catalog connection close failed",
          );
        }
      }
    }
    if (failure) throw failure;
  }

  #reportRecoveryRequired(): void {
    if (this.#recoveryReported) return;
    this.#recoveryReported = true;
    try {
      this.#onRecoveryRequired?.({
        component: "in_memory_catalog",
        workspaceId: this.#workspaceId,
      });
    } catch {
      // Recovery is already required; observer failures must not replace that result.
    }
  }

  async #ensureRequiredExtensions(
    metadata: CatalogSnapshot | CatalogTable,
    scoped = false,
  ): Promise<void> {
    for (const extension of requiredExtensions(metadata)) {
      if (this.#loadedExtensions.has(extension)) continue;
      if (scoped) {
        const result = await this.#session.request(
          "IN_MEMORY_CATALOG_LOAD_EXTENSION",
          "IN_MEMORY_CATALOG_LOAD_EXTENSION_RESULT",
          { update_token: this.#exclusiveToken, extension },
        );
        requireSuccessfulResult(result, "Could not load a scanner extension during the update");
      } else {
        await this.#connection.query(`LOAD ${extension}`);
      }
      this.#loadedExtensions.add(extension);
    }
  }
}

function requiredExtensions(metadata: unknown): Set<string> {
  const tables: unknown[] =
    isRecord(metadata) && Array.isArray(metadata.schemas)
      ? metadata.schemas.flatMap((schema) =>
          isRecord(schema) && Array.isArray(schema.tables) ? schema.tables : [],
        )
      : [metadata];
  const extensions = new Set<string>();
  if (tables.some(usesJsonExtension)) extensions.add("json");
  if (tables.some(usesExcelExtension)) extensions.add("excel");
  return extensions;
}

function usesJsonExtension(table: unknown): boolean {
  if (!isRecord(table)) return false;
  const usesJsonScanner = isRecord(table.scanner) && table.scanner.type === "json";
  const usesJsonColumn =
    Array.isArray(table.columns) &&
    table.columns.some(
      (column) =>
        isRecord(column) &&
        typeof column.type === "string" &&
        /(^|[^A-Za-z0-9_$])JSON([^A-Za-z0-9_$]|$)/u.test(column.type),
    );
  return usesJsonScanner || usesJsonColumn;
}

function usesExcelExtension(table: unknown): boolean {
  return isRecord(table) && isRecord(table.scanner) && table.scanner.type === "xlsx";
}

class WorkspaceSessionClient {
  #port: MessagePort;
  #ackTimeoutMs: number;
  #sequence = 0;
  #waiter: WorkspaceWaiter | undefined;
  #closed = false;

  static async open(
    worker: CatalogWorkerLike,
    workspaceId: string,
    ackTimeoutMs: number,
    connectionId?: number,
  ): Promise<WorkspaceSessionClient> {
    const channel = new MessageChannel();
    const client = new WorkspaceSessionClient(channel.port1, ackTimeoutMs);
    const opened = client.#waitFor("IN_MEMORY_CATALOG_WORKSPACE_SESSION_OPENED", undefined);
    try {
      worker.postMessage(
        {
          type: "IN_MEMORY_CATALOG_OPEN_WORKSPACE_SESSION",
          workspace_id: workspaceId,
          connection_id: connectionId,
        },
        [channel.port2],
      );
    } catch (error) {
      client.close();
      try {
        await opened;
      } catch {
        // Consume the waiter rejection caused by closing the local port.
      }
      throw new InMemoryCatalogControllerError(
        "RC_REMOTE_IO",
        error instanceof Error ? error.message : "Could not open Catalog workspace session",
      );
    }
    try {
      const result = await opened;
      requireSuccessfulResult(result, "Could not open Catalog workspace session");
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  constructor(port: MessagePort, ackTimeoutMs: number) {
    this.#port = port;
    this.#ackTimeoutMs = ackTimeoutMs;
    port.onmessage = (event) => this.#receive(event.data);
    port.onmessageerror = () =>
      this.#rejectWaiter(
        new InMemoryCatalogControllerError("RC_REMOTE_IO", "Catalog workspace reply was invalid"),
      );
    port.start?.();
  }

  request(
    type: string,
    resultType: string,
    payload: Record<string, unknown> = {},
  ): Promise<WorkspaceReply> {
    if (this.#closed) {
      return Promise.reject(
        new InMemoryCatalogControllerError(
          "RC_CATALOG_WORKSPACE_CLOSED",
          "Catalog workspace session is closed",
        ),
      );
    }
    if (this.#waiter) {
      return Promise.reject(
        new InMemoryCatalogControllerError(
          "RC_REMOTE_IO",
          "Catalog workspace already has an operation in flight",
        ),
      );
    }
    const requestId = `catalog-${++this.#sequence}`;
    const result = this.#waitFor(resultType, requestId);
    this.#port.postMessage({ type, request_id: requestId, ...payload });
    return result;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectWaiter(
      new InMemoryCatalogControllerError(
        "RC_REMOTE_IO",
        "Catalog workspace session closed before receiving a reply",
      ),
    );
    this.#port.close();
  }

  #waitFor(type: string, requestId: string | undefined): Promise<WorkspaceReply> {
    if (this.#waiter) {
      return Promise.reject(
        new InMemoryCatalogControllerError(
          "RC_REMOTE_IO",
          "Catalog workspace already has an operation in flight",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#waiter?.reject !== reject) return;
        this.#waiter = undefined;
        reject(
          new InMemoryCatalogControllerError(
            "RC_REMOTE_IO",
            "Catalog workspace acknowledgement timed out",
          ),
        );
      }, this.#ackTimeoutMs);
      this.#waiter = { type, requestId, resolve, reject, timeout };
    });
  }

  #receive(value: unknown): void {
    if (!isRecord(value)) return;
    const message = value as WorkspaceReply;
    const waiter = this.#waiter;
    if (!waiter || message?.type !== waiter.type) return;
    if (waiter.requestId !== undefined && message?.request_id !== waiter.requestId) return;
    this.#waiter = undefined;
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
  }

  #rejectWaiter(error: unknown): void {
    const waiter = this.#waiter;
    if (!waiter) return;
    this.#waiter = undefined;
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
}

function normalizeOptions(input: unknown): NormalizedControllerOptions {
  if (!input || typeof input !== "object") {
    throw new InMemoryCatalogControllerError(
      "RC_METADATA_INVALID",
      "Controller options are required",
    );
  }
  const options = input as Record<string, unknown>;
  if (
    options.onRecoveryRequired !== undefined &&
    typeof options.onRecoveryRequired !== "function"
  ) {
    throw new InMemoryCatalogControllerError(
      "RC_METADATA_INVALID",
      "onRecoveryRequired must be a function",
    );
  }
  const ackTimeoutMs = options.ackTimeoutMs === undefined ? 5_000 : options.ackTimeoutMs;
  if (
    typeof ackTimeoutMs !== "number" ||
    !Number.isSafeInteger(ackTimeoutMs) ||
    ackTimeoutMs <= 0
  ) {
    throw new InMemoryCatalogControllerError(
      "RC_METADATA_INVALID",
      "ackTimeoutMs must be a positive safe integer",
    );
  }
  return {
    workspaceId: requireName(options.workspaceId, "workspaceId"),
    catalogName: requireName(options.catalogName, "catalogName"),
    extension: normalizeExtension(options),
    ackTimeoutMs,
    ...(options.onRecoveryRequired === undefined
      ? {}
      : {
          onRecoveryRequired: options.onRecoveryRequired as (
            details: CatalogRecoveryDetails,
          ) => void,
        }),
  };
}

function normalizeExtension(options: Record<string, unknown>): NormalizedExtensionOptions {
  if (options.extension !== undefined) {
    if (!isRecord(options.extension)) {
      throw new InMemoryCatalogControllerError(
        "RC_METADATA_INVALID",
        "extension must be an object",
      );
    }
    const extension = options.extension;
    if (options.extensionName !== undefined) {
      throw new InMemoryCatalogControllerError(
        "RC_METADATA_INVALID",
        "extensionName cannot be combined with extension",
      );
    }
    const name =
      extension.name === undefined
        ? "in_memory_catalog"
        : requireName(extension.name, "extension.name");
    const url =
      extension.url === undefined
        ? undefined
        : requireExtensionLocation(extension.url, "extension.url");
    const repository =
      extension.repository === undefined
        ? undefined
        : requireExtensionLocation(extension.repository, "extension.repository");
    if (url !== undefined && repository !== undefined) {
      throw new InMemoryCatalogControllerError(
        "RC_METADATA_INVALID",
        "extension.url and extension.repository are mutually exclusive",
      );
    }
    return { name, url, repository };
  }

  const name =
    options.extensionName === undefined
      ? "in_memory_catalog"
      : requireName(options.extensionName, "extensionName");
  return { name };
}

function requireExtensionLocation(value: unknown, field: string): string {
  return requireName(value, field);
}

function requireWorkerUrl(value: unknown, field: string): URL {
  if (value instanceof URL) return new URL(value.href);
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new InMemoryCatalogControllerError(
      "RC_METADATA_INVALID",
      `${field} must be a non-empty URL string or URL object without NUL`,
    );
  }
  try {
    return new URL(value, import.meta.url);
  } catch {
    throw new InMemoryCatalogControllerError(
      "RC_METADATA_INVALID",
      `${field} must be a valid URL string or URL object`,
    );
  }
}

function requireSuccessfulResult(result: WorkspaceReply, fallbackMessage: string): void {
  if (result?.ok === true) return;
  throw new InMemoryCatalogControllerError(
    typeof result?.code === "string" ? result.code : "RC_REMOTE_IO",
    typeof result?.message === "string" ? result.message : fallbackMessage,
  );
}

function requireName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new InMemoryCatalogControllerError(
      "RC_METADATA_INVALID",
      `${field} must be a non-empty string without NUL`,
    );
  }
  return value;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
