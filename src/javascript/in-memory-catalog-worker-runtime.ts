import { createDuckDBQueryGate } from "./in-memory-catalog-query-gate";

(function initializeInMemoryCatalogWorkerRuntime(global) {
  "use strict";

  const OPEN_SESSION = "IN_MEMORY_CATALOG_OPEN_WORKSPACE_SESSION";
  const REPLACE_SNAPSHOT = "IN_MEMORY_CATALOG_REPLACE_SNAPSHOT";
  const REPLACE_TABLE = "IN_MEMORY_CATALOG_REPLACE_TABLE";
  const REPLACE_VIEW = "IN_MEMORY_CATALOG_REPLACE_VIEW";
  const DROP_WORKSPACE = "IN_MEMORY_CATALOG_DROP_WORKSPACE";
  const GET_DIAGNOSTICS = "IN_MEMORY_CATALOG_GET_DIAGNOSTICS";
  const GATE_MESSAGES = new Set([
    "IN_MEMORY_CATALOG_ACQUIRE_UPDATE",
    "IN_MEMORY_CATALOG_RELEASE_UPDATE",
    "IN_MEMORY_CATALOG_CANCEL_UPDATE",
    "IN_MEMORY_CATALOG_FAIL_UPDATE",
    "IN_MEMORY_CATALOG_LOAD_EXTENSION",
  ]);

  function createInMemoryCatalogWorkerRuntime(store, gate = createDuckDBQueryGate()) {
    const bridge = Object.freeze({
      currentRevision(workspaceId) {
        return store.currentRevision(workspaceId)?.toString();
      },

      lookupTable(workspaceId, revision, schemaName, tableName) {
        const table = store.lookupTable(workspaceId, revision, schemaName, tableName);
        if (!table) return undefined;
        return JSON.stringify({
          catalog_revision: revision,
          schema_name: schemaName,
          table_name: tableName,
          snapshot: table.snapshot,
          scanner: table.scanner,
          columns: table.columns,
          files: table.files,
        });
      },

      lookupView(workspaceId, revision, schemaName, viewName) {
        const view = store.lookupView(workspaceId, revision, schemaName, viewName);
        if (!view) return undefined;
        return JSON.stringify({
          catalog_revision: revision,
          schema_name: schemaName,
          view_name: viewName,
          query: view.query,
        });
      },

      listSchemas(workspaceId, revision) {
        return JSON.stringify(store.listSchemas(workspaceId, revision));
      },

      listTables(workspaceId, revision, schemaName) {
        return JSON.stringify(store.listTables(workspaceId, revision, schemaName));
      },

      listViews(workspaceId, revision, schemaName) {
        return JSON.stringify(store.listViews(workspaceId, revision, schemaName));
      },

      diagnostics() {
        return JSON.stringify(store.diagnostics());
      },
    });

    async function handleMessage(event) {
      if (event?.data?.type !== OPEN_SESSION) {
        throw new Error(`Unsupported In-Memory Catalog message type: ${String(event?.data?.type)}`);
      }
      const port = event.ports?.[0];
      if (!port) throw new Error(`${OPEN_SESSION} requires a dedicated MessagePort`);

      let session;
      try {
        session = store.openWorkspaceSession(event.data.workspace_id);
      } catch (error) {
        port.postMessage({
          type: "IN_MEMORY_CATALOG_WORKSPACE_SESSION_OPENED",
          ok: false,
          code: errorCode(error),
          message: safeOpenErrorMessage(error),
        });
        port.close();
        return;
      }

      const owner = { connectionId: event.data.connection_id };
      port.onmessage = (sessionEvent) =>
        handleSessionMessage(session, port, sessionEvent.data, gate, owner);
      port.onmessageerror = () => {
        gate.abandon(owner);
        port.close();
      };
      port.start?.();
      port.postMessage({ type: "IN_MEMORY_CATALOG_WORKSPACE_SESSION_OPENED", ok: true });
    }

    return Object.freeze({ bridge, handleMessage });
  }

  async function handleSessionMessage(session, port, message, gate, owner) {
    const requestId = message?.request_id;
    if (GATE_MESSAGES.has(message?.type)) {
      await handleGateMessage(gate, owner, port, message);
      return;
    }
    if (message?.type === REPLACE_SNAPSHOT) {
      try {
        await gate.publishMetadata(owner, message.update_token, () =>
          session.replaceCatalogSnapshot(message.snapshot),
        );
        port.postMessage({
          type: "IN_MEMORY_CATALOG_REPLACE_SNAPSHOT_RESULT",
          request_id: requestId,
          ok: true,
        });
      } catch (error) {
        port.postMessage({
          type: "IN_MEMORY_CATALOG_REPLACE_SNAPSHOT_RESULT",
          request_id: requestId,
          ok: false,
          code: errorCode(error),
          message: safeOperationErrorMessage(error),
        });
      }
      return;
    }

    if (message?.type === REPLACE_TABLE) {
      try {
        await gate.publishMetadata(owner, message.update_token, () =>
          session.replaceCatalogTable(message.schema_name, message.table),
        );
        port.postMessage({
          type: "IN_MEMORY_CATALOG_REPLACE_TABLE_RESULT",
          request_id: requestId,
          ok: true,
        });
      } catch (error) {
        port.postMessage({
          type: "IN_MEMORY_CATALOG_REPLACE_TABLE_RESULT",
          request_id: requestId,
          ok: false,
          code: errorCode(error),
          message: safeOperationErrorMessage(error),
        });
      }
      return;
    }

    if (message?.type === REPLACE_VIEW) {
      try {
        await gate.publishMetadata(owner, message.update_token, () =>
          session.replaceCatalogView(message.schema_name, message.view),
        );
        port.postMessage({
          type: "IN_MEMORY_CATALOG_REPLACE_VIEW_RESULT",
          request_id: requestId,
          ok: true,
        });
      } catch (error) {
        port.postMessage({
          type: "IN_MEMORY_CATALOG_REPLACE_VIEW_RESULT",
          request_id: requestId,
          ok: false,
          code: errorCode(error),
          message: safeOperationErrorMessage(error),
        });
      }
      return;
    }

    if (message?.type === DROP_WORKSPACE) {
      try {
        gate.abandon(owner);
        const result = await session.dropCatalogWorkspace();
        port.postMessage({
          type: "IN_MEMORY_CATALOG_DROP_WORKSPACE_RESULT",
          request_id: requestId,
          ok: true,
          ...result,
        });
        port.close();
      } catch (error) {
        port.postMessage({
          type: "IN_MEMORY_CATALOG_DROP_WORKSPACE_RESULT",
          request_id: requestId,
          ok: false,
          code: errorCode(error),
          message: safeOperationErrorMessage(error),
        });
      }
      return;
    }

    if (message?.type === GET_DIAGNOSTICS) {
      port.postMessage({
        type: "IN_MEMORY_CATALOG_GET_DIAGNOSTICS_RESULT",
        request_id: requestId,
        ok: true,
        diagnostics: session.diagnostics(),
      });
      return;
    }

    port.postMessage({
      type: "IN_MEMORY_CATALOG_SESSION_ERROR",
      request_id: requestId,
      ok: false,
      code: "RC_METADATA_INVALID",
      message: "Unsupported In-Memory Catalog session message",
    });
  }

  async function handleGateMessage(gate, owner, port, message) {
    const operations = {
      IN_MEMORY_CATALOG_ACQUIRE_UPDATE: () => gate.acquire(owner, message.update_token),
      IN_MEMORY_CATALOG_RELEASE_UPDATE: () => gate.release(owner, message.update_token, false),
      IN_MEMORY_CATALOG_CANCEL_UPDATE: () => gate.cancel(owner, message.update_token),
      IN_MEMORY_CATALOG_FAIL_UPDATE: () => gate.release(owner, message.update_token, true),
      IN_MEMORY_CATALOG_LOAD_EXTENSION: () =>
        gate.loadExtension(owner, message.update_token, owner.connectionId, message.extension),
    };
    const operation = operations[message?.type];
    if (!operation) return false;
    try {
      if (typeof message.update_token !== "string" || !message.update_token) {
        throw Object.assign(new Error("An exclusive update token is required"), {
          code: "RC_METADATA_INVALID",
        });
      }
      await operation();
      port.postMessage({
        type: `${message.type}_RESULT`,
        request_id: message.request_id,
        ok: true,
      });
    } catch (error) {
      port.postMessage({
        type: `${message.type}_RESULT`,
        request_id: message.request_id,
        ok: false,
        code: errorCode(error),
        message: safeOperationErrorMessage(error),
      });
    }
    return true;
  }

  function errorCode(error) {
    return typeof error?.code === "string" ? error.code : "RC_METADATA_INVALID";
  }

  function safeOpenErrorMessage(error) {
    if (error?.code === "RC_CATALOG_WORKSPACE_ALREADY_ACTIVE") {
      return "Catalog workspace already has an active writer";
    }
    return "Could not open Catalog workspace session";
  }

  function safeOperationErrorMessage(error) {
    if (typeof error?.code === "string" && typeof error?.message === "string") {
      return error.message;
    }
    return "Catalog workspace operation failed";
  }

  global.DuckDBInMemoryCatalogWorkerRuntime = Object.freeze({
    createInMemoryCatalogWorkerRuntime,
    createDuckDBQueryGate,
  });
})(globalThis);
