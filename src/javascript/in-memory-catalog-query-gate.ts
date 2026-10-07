interface DuckDBRequest {
  type: string;
  messageId: number;
  data: unknown;
}

interface DuckDBResponse {
  type: string;
  requestId: number;
  data?: unknown;
}

interface GateLock {
  owner: object;
  token: string;
  held: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

const STREAM_STARTS = new Set(["START_PENDING_QUERY", "SEND_PREPARED"]);
const STREAM_CONTINUATIONS = new Set([
  "POLL_PENDING_QUERY",
  "FETCH_QUERY_RESULTS",
  "CANCEL_PENDING_QUERY",
]);
const CONTROL_REQUESTS = new Set([
  "PING",
  "GET_VERSION",
  "GET_FEATURE_FLAGS",
  "TOKENIZE",
  "DISCONNECT",
  "CLOSE_PREPARED",
]);

function gateError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Worker-wide coordination based on protocol replies, not dispatcher return values. */
export function createDuckDBQueryGate(
  dispatch: (event: { data: DuckDBRequest }) => unknown = () => undefined,
  post: (response: DuckDBResponse & { messageId: number }) => void = () => undefined,
) {
  const active = new Map<number, DuckDBRequest>();
  const streams = new Set<number>();
  const queued: Array<{ data: DuckDBRequest }> = [];
  const internal = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let lock: GateLock | undefined;
  let failed = false;
  let sequence = -1;
  let metadataActive = 0;

  function recoveryError() {
    return gateError(
      "RC_CATALOG_RECOVERY_REQUIRED",
      "Exclusive update failed; recreate the DuckDB Worker",
    );
  }

  function rejectRequest(request: DuckDBRequest, error: Error & { code?: string }) {
    post({
      messageId: sequence--,
      requestId: request.messageId,
      type: "ERROR",
      data: {
        name: error.name,
        message: `${error.code ?? "RC_REMOTE_IO"}: ${error.message}`,
        code: error.code,
      },
    });
  }

  function grantIfIdle() {
    if (lock && !lock.held && active.size === 0 && metadataActive === 0) {
      lock.held = true;
      lock.resolve();
    }
  }

  function dispatchTracked(event: { data: DuckDBRequest }) {
    const request = event.data;
    active.set(request.messageId, request);
    if (STREAM_STARTS.has(request.type)) streams.add((request.data as number[])[0]);
    try {
      // Some classic Worker entrypoints return void even for asynchronous dispatch.
      const result = dispatch(event);
      Promise.resolve(result).catch((error) => dispatchFailed(request, error));
    } catch (error) {
      dispatchFailed(request, error);
    }
  }

  function dispatchFailed(request: DuckDBRequest, error: unknown) {
    if (!active.has(request.messageId)) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    const forward = observeResponse({
      type: "ERROR",
      requestId: request.messageId,
      data: { message: failure.message },
    });
    if (forward) rejectRequest(request, failure);
  }

  function streamStartError(request: DuckDBRequest): (Error & { code: string }) | undefined {
    if (STREAM_STARTS.has(request.type) && streams.has((request.data as number[])[0])) {
      return gateError(
        "RC_CATALOG_STREAM_ACTIVE",
        "A streaming query is already active on this connection",
      );
    }
    if (STREAM_STARTS.has(request.type) && lock) {
      return gateError(
        "RC_CATALOG_STREAM_ACTIVE",
        "Streaming cannot start during an exclusive update",
      );
    }
    return undefined;
  }

  function continuationError(request: DuckDBRequest): (Error & { code: string }) | undefined {
    if (!STREAM_CONTINUATIONS.has(request.type)) return undefined;
    if (!failed && !lock) return undefined;
    if (streams.has(request.data as number)) return undefined;
    return gateError(
      "RC_CATALOG_UPDATE_BUSY",
      "No active stream can be continued during this update",
    );
  }

  function handleMessage(event: { data: DuckDBRequest }) {
    const request = event.data;
    const streamError = streamStartError(request) ?? continuationError(request);
    if (streamError) {
      rejectRequest(request, streamError);
    } else if (CONTROL_REQUESTS.has(request.type) || STREAM_CONTINUATIONS.has(request.type)) {
      dispatchTracked(event);
    } else if (failed) {
      rejectRequest(request, recoveryError());
    } else if (lock) {
      queued.push(event);
    } else {
      dispatchTracked(event);
    }
  }

  function streamEnded(request: DuckDBRequest, response: DuckDBResponse): boolean {
    // A failed fetch/poll does not prove that DuckDB discarded its result.
    if (STREAM_STARTS.has(request.type)) return response.type === "ERROR";
    if (request.type === "FETCH_QUERY_RESULTS") {
      return response.data != null && (response.data as Uint8Array).byteLength === 0;
    }
    if (request.type === "CANCEL_PENDING_QUERY") return response.data === true;
    if (request.type === "DISCONNECT") return response.type === "OK";
    return false;
  }

  function updateStreamState(request: DuckDBRequest, response: DuckDBResponse) {
    if (!streamEnded(request, response)) return;
    const connection = Array.isArray(request.data) ? request.data[0] : request.data;
    streams.delete(connection);
  }

  function observeResponse(response: DuckDBResponse): boolean {
    if (response.type === "LOG" || response.type === "INSTANTIATE_PROGRESS") return true;
    const request = active.get(response.requestId);
    if (!request) return true;
    active.delete(response.requestId);
    updateStreamState(request, response);
    const waiter = internal.get(response.requestId);
    if (waiter) {
      internal.delete(response.requestId);
      if (response.type === "ERROR")
        waiter.reject(
          new Error(
            String(
              (response.data as { message?: string })?.message ?? "Internal DuckDB request failed",
            ),
          ),
        );
      else waiter.resolve();
    }
    queueMicrotask(grantIfIdle);
    return !waiter;
  }

  function acquire(owner: object, token: string): Promise<void> {
    if (failed) return Promise.reject(recoveryError());
    if (lock)
      return Promise.reject(
        gateError("RC_CATALOG_UPDATE_BUSY", "Another exclusive update is pending or active"),
      );
    if (streams.size)
      return Promise.reject(
        gateError(
          "RC_CATALOG_STREAM_ACTIVE",
          "Drain or cancel active streaming queries before updating",
        ),
      );
    return new Promise((resolve, reject) => {
      lock = { owner, token, held: false, resolve, reject };
      grantIfIdle();
    });
  }

  function requireOwner(owner: object, token: string) {
    if (!lock || lock.owner !== owner || lock.token !== token) {
      throw gateError(
        "RC_CATALOG_UPDATE_SCOPE",
        "Exclusive update token does not own the Worker gate",
      );
    }
    return lock;
  }

  function flush() {
    const waiting = queued.splice(0);
    for (const event of waiting) handleMessage(event);
  }

  function release(owner: object, token: string, fail: boolean) {
    const held = requireOwner(owner, token);
    lock = undefined;
    if (fail) failed = true;
    if (!held.held)
      held.reject(
        gateError("RC_CATALOG_UPDATE_CANCELLED", "Exclusive update acquisition was cancelled"),
      );
    flush();
  }

  function cancel(owner: object, token: string) {
    if (lock?.owner === owner && lock.token === token) release(owner, token, false);
  }

  function assertMetadata(owner: object, token?: string) {
    if (failed) throw recoveryError();
    if (lock) requireOwner(owner, token ?? "");
  }

  async function publishMetadata<T>(
    owner: object,
    token: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertMetadata(owner, token);
    metadataActive += 1;
    try {
      return await operation();
    } finally {
      metadataActive -= 1;
      grantIfIdle();
    }
  }

  function loadExtension(
    owner: object,
    token: string,
    connection: number,
    extension: string,
  ): Promise<void> {
    const held = requireOwner(owner, token);
    if (!held.held || !Number.isSafeInteger(connection) || !["json", "excel"].includes(extension)) {
      return Promise.reject(gateError("RC_METADATA_INVALID", "Invalid scoped extension load"));
    }
    const messageId = sequence--;
    return new Promise((resolve, reject) => {
      internal.set(messageId, { resolve, reject });
      dispatchTracked({
        data: { type: "RUN_QUERY", messageId, data: [connection, `LOAD ${extension}`] },
      });
    });
  }

  function abandon(owner: object) {
    if (lock?.owner === owner) release(owner, lock.token, true);
  }

  return {
    handleMessage,
    observeResponse,
    acquire,
    release,
    cancel,
    publishMetadata,
    loadExtension,
    abandon,
  };
}
