import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createDuckDBQueryGate } from "../../src/javascript/in-memory-catalog-query-gate";

function fixture() {
  const dispatched: Array<{ data: { messageId: number; type: string; data: unknown } }> = [];
  const rejected: Array<{ requestId: number; data?: unknown }> = [];
  const gate = createDuckDBQueryGate(
    (event) => {
      dispatched.push(event);
    },
    (response) => {
      rejected.push(response);
    },
  );
  const request = (messageId: number, type: string, data: unknown) =>
    gate.handleMessage({ data: { messageId, type, data } });
  const reply = (requestId: number, type = "QUERY_RESULT", data: unknown = new Uint8Array([1])) =>
    gate.observeResponse({ requestId, type, data });
  return { gate, dispatched, rejected, request, reply };
}

describe("Worker-wide DuckDB query gate", () => {
  it("waits for exact terminal replies across connections and queues query/prepared starts", async () => {
    const f = fixture();
    const owner = {};
    f.request(1, "RUN_QUERY", [10, "SELECT 1"]);
    f.request(2, "RUN_PREPARED", [20, 5, []]);
    let acquired = false;
    const acquire = f.gate.acquire(owner, "token").then(() => {
      acquired = true;
    });
    await assert.rejects(
      f.gate.publishMetadata(owner, "token", async () => {}),
      { code: "RC_CATALOG_UPDATE_SCOPE" },
    );
    f.request(3, "RUN_QUERY", [30, "SELECT 2"]);
    f.request(4, "CREATE_PREPARED", [40, "SELECT 3"]);
    f.request(5, "START_PENDING_QUERY", [50, "SELECT 4", true]);
    f.reply(1, "LOG");
    await Promise.resolve();
    assert.equal(acquired, false);
    f.reply(1);
    await Promise.resolve();
    assert.equal(acquired, false);
    f.reply(2);
    await acquire;
    assert.deepEqual(
      f.dispatched.map((event) => event.data.messageId),
      [1, 2],
    );
    assert.equal(f.rejected[0].requestId, 5);
    f.gate.release(owner, "token", false);
    assert.deepEqual(
      f.dispatched.map((event) => event.data.messageId),
      [1, 2, 3, 4],
    );
  });

  it("requires an acquired owner token for every metadata publication", async () => {
    const f = fixture();
    const owner = {};
    await assert.rejects(
      f.gate.publishMetadata(owner, undefined, async () => {}),
      { code: "RC_CATALOG_UPDATE_SCOPE" },
    );
    await f.gate.acquire(owner, "token");
    await assert.rejects(
      f.gate.publishMetadata({}, undefined, async () => {}),
      { code: "RC_CATALOG_UPDATE_SCOPE" },
    );
    await f.gate.publishMetadata(owner, "token", async () => {});
    let finish!: () => void;
    const pending = f.gate.publishMetadata(
      owner,
      "token",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    assert.throws(() => f.gate.release(owner, "token", false), { code: "RC_CATALOG_UPDATE_BUSY" });
    finish();
    await pending;
    f.gate.release(owner, "token", false);
  });

  it("tracks streams through headers, null fetches, chunks, and actual end-of-stream", async () => {
    const f = fixture();
    const owner = {};
    f.request(1, "START_PENDING_QUERY", [10, "SELECT 1", true]);
    f.reply(1, "QUERY_RESULT_HEADER_OR_NULL", null);
    await assert.rejects(f.gate.acquire(owner, "token"), { code: "RC_CATALOG_STREAM_ACTIVE" });
    f.request(2, "START_PENDING_QUERY", [10, "SELECT 2", true]);
    assert.equal(f.rejected[0].requestId, 2);
    f.request(3, "POLL_PENDING_QUERY", 10);
    f.reply(3, "QUERY_RESULT_HEADER_OR_NULL", new Uint8Array([1]));
    f.request(4, "FETCH_QUERY_RESULTS", 10);
    f.reply(4, "QUERY_RESULT_CHUNK", null);
    await assert.rejects(f.gate.acquire(owner, "token"), { code: "RC_CATALOG_STREAM_ACTIVE" });
    f.request(5, "FETCH_QUERY_RESULTS", 10);
    f.reply(5, "QUERY_RESULT_CHUNK", new Uint8Array([1]));
    await assert.rejects(f.gate.acquire(owner, "token"), { code: "RC_CATALOG_STREAM_ACTIVE" });
    f.request(6, "FETCH_QUERY_RESULTS", 10);
    f.reply(6, "QUERY_RESULT_CHUNK", new Uint8Array());
    await f.gate.acquire(owner, "token");
    f.gate.release(owner, "token", false);
  });

  it("clears streams on successful cancellation or disconnect", async () => {
    for (const completion of ["CANCEL_PENDING_QUERY", "DISCONNECT"]) {
      const f = fixture();
      f.request(1, "SEND_PREPARED", [10, 2, []]);
      f.reply(1, "QUERY_RESULT_HEADER");
      f.request(2, completion, 10);
      f.reply(2, completion === "DISCONNECT" ? "OK" : "SUCCESS", true);
      const owner = {};
      await f.gate.acquire(owner, "token");
      f.gate.release(owner, "token", false);
    }
  });

  it("keeps a failed fetch reserved until the stream is explicitly cancelled", async () => {
    const f = fixture();
    f.request(1, "SEND_PREPARED", [10, 2, []]);
    f.reply(1, "QUERY_RESULT_HEADER");
    f.request(2, "FETCH_QUERY_RESULTS", 10);
    f.reply(2, "ERROR", { message: "Read failed" });
    const owner = {};
    await assert.rejects(f.gate.acquire(owner, "token"), { code: "RC_CATALOG_STREAM_ACTIVE" });
    f.request(3, "CANCEL_PENDING_QUERY", 10);
    f.reply(3, "SUCCESS", true);
    await f.gate.acquire(owner, "token");
    f.gate.release(owner, "token", false);
  });

  it("executes only token-authorized extension loads while leaving normal queries queued", async () => {
    const f = fixture();
    const owner = {};
    await f.gate.acquire(owner, "token");
    assert.throws(() => f.gate.loadExtension({}, "token", 10, "json"), {
      code: "RC_CATALOG_UPDATE_SCOPE",
    });
    await assert.rejects(f.gate.loadExtension(owner, "token", 10, "httpfs"), {
      code: "RC_METADATA_INVALID",
    });
    const load = f.gate.loadExtension(owner, "token", 10, "json");
    f.request(1, "RUN_QUERY", [20, "SELECT 1"]);
    const internal = f.dispatched[0].data;
    assert.deepEqual(internal.data, [10, "LOAD json"]);
    assert.equal(f.reply(internal.messageId), false);
    await load;
    assert.equal(f.dispatched.length, 1);
    f.gate.release(owner, "token", false);
    assert.equal(f.dispatched.length, 2);
  });

  it("fails closed globally but permits disconnect cleanup", async () => {
    const f = fixture();
    const owner = {};
    await f.gate.acquire(owner, "token");
    f.request(1, "RUN_QUERY", [10, "SELECT 1"]);
    f.gate.release(owner, "token", true);
    for (const [index, type] of [
      "RUN_PREPARED",
      "CREATE_PREPARED",
      "INSERT_CSV_FROM_PATH",
      "COPY_FILE_TO_BUFFER",
      "UNKNOWN_NEW_OPERATION",
    ].entries()) {
      f.request(index + 2, type, [20, "file"]);
    }
    assert.equal(f.rejected.length, 6);
    assert.equal(f.dispatched.length, 0);
    await assert.rejects(f.gate.acquire({}, "other"), { code: "RC_CATALOG_RECOVERY_REQUIRED" });
    await assert.rejects(
      f.gate.publishMetadata({}, undefined, async () => {}),
      { code: "RC_CATALOG_RECOVERY_REQUIRED" },
    );
    f.request(20, "DISCONNECT", 10);
    assert.equal(f.dispatched.length, 1);
  });

  it("cancels pending and late-granted acquisitions without orphaning the lock", async () => {
    const f = fixture();
    const owner = {};
    f.request(1, "RUN_QUERY", [10, "slow"]);
    const cancelled = assert.rejects(f.gate.acquire(owner, "first"), {
      code: "RC_CATALOG_UPDATE_CANCELLED",
    });
    f.gate.cancel(owner, "first");
    await cancelled;
    f.reply(1);
    await f.gate.acquire(owner, "second");
    f.gate.cancel(owner, "second");
    await f.gate.acquire({}, "third");
  });
});
