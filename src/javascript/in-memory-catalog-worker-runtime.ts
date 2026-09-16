(function initializeInMemoryCatalogWorkerRuntime(global) {
  "use strict";

  const OPEN_SESSION = "IN_MEMORY_CATALOG_OPEN_WORKSPACE_SESSION";
  const REPLACE_SNAPSHOT = "IN_MEMORY_CATALOG_REPLACE_SNAPSHOT";
  const REPLACE_TABLE = "IN_MEMORY_CATALOG_REPLACE_TABLE";
  const REPLACE_VIEW = "IN_MEMORY_CATALOG_REPLACE_VIEW";
  const DROP_WORKSPACE = "IN_MEMORY_CATALOG_DROP_WORKSPACE";
  const GET_DIAGNOSTICS = "IN_MEMORY_CATALOG_GET_DIAGNOSTICS";

  function createInMemoryCatalogWorkerRuntime(store) {
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

      port.onmessage = (sessionEvent) => handleSessionMessage(session, port, sessionEvent.data);
      port.onmessageerror = () => port.close();
      port.start?.();
      port.postMessage({ type: "IN_MEMORY_CATALOG_WORKSPACE_SESSION_OPENED", ok: true });
    }

    return Object.freeze({ bridge, handleMessage });
  }

  async function handleSessionMessage(session, port, message) {
    const requestId = message?.request_id;
    if (message?.type === REPLACE_SNAPSHOT) {
      try {
        await session.replaceCatalogSnapshot(message.snapshot);
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
        await session.replaceCatalogTable(message.schema_name, message.table);
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
        await session.replaceCatalogView(message.schema_name, message.view);
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
  });
})(globalThis);

export {};
