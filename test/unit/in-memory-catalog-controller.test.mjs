import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

await import('../../src/javascript/in-memory-catalog-metadata-store.js')
await import('../../src/javascript/in-memory-catalog-worker-runtime.js')
const {
  InMemoryCatalogController,
  InMemoryCatalogControllerError,
} = await import('../../src/javascript/in-memory-catalog-controller.mjs')

const { InMemoryCatalogMetadataStore } = globalThis.DuckDBInMemoryCatalogMetadata
const { createInMemoryCatalogWorkerRuntime } = globalThis.DuckDBInMemoryCatalogWorkerRuntime

function snapshot(uri = 'https://example.test/table.parquet') {
  return {
    format_version: 1,
    schemas: [{
      name: 'main',
      tables: [{
        name: 'table1',
        snapshot: 'snapshot-1',
        columns: [{ name: 'id', type: 'BIGINT', nullable: false }],
        files: [{ uri }],
      }],
    }],
  }
}

function fakeDatabase() {
  const queries = []
  const connection = {
    closed: false,
    async query(sql) { queries.push(sql) },
    async close() { this.closed = true },
  }
  return { db: { async connect() { return connection } }, connection, queries }
}

function runtimeWorker(runtime) {
  return {
    terminated: false,
    postMessage(data, ports) { void runtime.handleMessage({ data, ports }) },
    terminate() { this.terminated = true },
  }
}

describe('InMemoryCatalogController', () => {
  it('opens, publishes, attaches, refreshes, then detaches and drops without owning the Worker', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const worker = runtimeWorker(createInMemoryCatalogWorkerRuntime(store))
    const { db, connection, queries } = fakeDatabase()
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      { workspaceId: 'workspace', catalogName: 'dataset', ackTimeoutMs: 100 },
      1n,
      snapshot(),
    )

    await controller.publishSnapshot(2n, snapshot('https://example.test/revision-2.parquet'))
    assert.equal((await controller.diagnostics()).active_workspace_session_count, 1)
    const firstClose = controller.close()
    const secondClose = controller.close()

    assert.equal(firstClose, secondClose)
    await firstClose
    assert.deepEqual(queries, [
      'LOAD parquet',
      "LOAD 'in_memory_catalog'",
      'ATTACH \'workspace\' AS "dataset" (TYPE in_memory_catalog, READ_ONLY)',
      'DETACH "dataset"',
    ])
    assert.equal(connection.closed, true)
    assert.equal(worker.terminated, false)
    assert.equal(controller.state, 'closed')
    assert.equal(store.diagnostics().active_workspace_session_count, 0)
  })

  it('closes successfully after publishing MAX_UINT64', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const worker = runtimeWorker(createInMemoryCatalogWorkerRuntime(store))
    const { db } = fakeDatabase()
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      { workspaceId: 'workspace', catalogName: 'dataset', ackTimeoutMs: 100 },
      (1n << 64n) - 1n,
      snapshot(),
    )

    await controller.close()

    assert.equal(controller.state, 'closed')
    assert.equal(store.diagnostics().retained_workspace_snapshot_count, 0)
  })

  it('enters failed_closed, releases local resources, and reports recovery when drop ack times out', async () => {
    const recovery = []
    const { db, connection } = fakeDatabase()
    const worker = workerWithoutDropAck()
    const controller = await InMemoryCatalogController.initialize(
      db,
      worker,
      {
        workspaceId: 'workspace',
        catalogName: 'dataset',
        ackTimeoutMs: 5,
        onRecoveryRequired(details) {
          recovery.push(details)
          throw new Error('observer failure')
        },
      },
      1n,
      snapshot(),
    )

    await assert.rejects(controller.close(), (error) => {
      assert.ok(error instanceof InMemoryCatalogControllerError)
      assert.equal(error.code, 'RC_CATALOG_RECOVERY_REQUIRED')
      return true
    })

    assert.equal(controller.state, 'failed_closed')
    assert.equal(connection.closed, true)
    assert.deepEqual(recovery, [{ component: 'in_memory_catalog', workspaceId: 'workspace' }])
    await assert.rejects(
      () => controller.publishSnapshot(2n, snapshot()),
      (error) => error.code === 'RC_CATALOG_WORKSPACE_CLOSED',
    )
  })
})

function workerWithoutDropAck() {
  const worker = {}
  worker.postMessage = (data, ports) => {
    const port = ports[0]
    port.onmessage = (event) => {
      if (event.data.type === 'IN_MEMORY_CATALOG_REPLACE_SNAPSHOT') {
        port.postMessage({
          type: 'IN_MEMORY_CATALOG_REPLACE_SNAPSHOT_RESULT',
          request_id: event.data.request_id,
          ok: true,
          revision: event.data.catalog_revision.toString(),
          idempotent: false,
        })
      }
    }
    port.postMessage({ type: 'IN_MEMORY_CATALOG_WORKSPACE_SESSION_OPENED', ok: true })
  }
  return worker
}
