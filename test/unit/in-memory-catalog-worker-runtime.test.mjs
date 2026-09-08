import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

await import('../../src/javascript/in-memory-catalog-metadata-store.js')
await import('../../src/javascript/in-memory-catalog-worker-runtime.js')

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

class FakePort {
  messages = []
  closed = false
  onmessage
  onmessageerror

  postMessage(message) {
    assert.equal(this.closed, false)
    this.messages.push(structuredClone(message))
  }

  close() {
    this.closed = true
  }

  async dispatch(message) {
    return this.onmessage?.({ data: message })
  }
}

describe('In-Memory Catalog Worker runtime', () => {
  it('opens a dedicated session and exposes URI-only bridge descriptors', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const runtime = createInMemoryCatalogWorkerRuntime(store)
    const port = new FakePort()

    await runtime.handleMessage({
      data: { type: 'IN_MEMORY_CATALOG_OPEN_WORKSPACE_SESSION', workspace_id: 'workspace' },
      ports: [port],
    })
    await port.dispatch({
      type: 'IN_MEMORY_CATALOG_REPLACE_SNAPSHOT',
      request_id: 'replace-1',
      catalog_revision: 1n,
      snapshot: snapshot(),
    })

    assert.deepEqual(port.messages, [
      { type: 'IN_MEMORY_CATALOG_WORKSPACE_SESSION_OPENED', ok: true },
      {
        type: 'IN_MEMORY_CATALOG_REPLACE_SNAPSHOT_RESULT',
        request_id: 'replace-1',
        ok: true,
        revision: '1',
        idempotent: false,
      },
    ])
    assert.equal(runtime.bridge.currentRevision('workspace'), '1')
    assert.deepEqual(
      JSON.parse(runtime.bridge.lookupTable('workspace', '1', 'main', 'table1')).files,
      [{ uri: 'https://example.test/table.parquet' }],
    )
    await port.dispatch({
      type: 'IN_MEMORY_CATALOG_GET_DIAGNOSTICS',
      request_id: 'diagnostics-1',
    })
    assert.equal(port.messages.at(-1).diagnostics.full_lookup_count, 1)
  })

  it('drops a MAX_UINT64 workspace before acknowledging and closes the port', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const runtime = createInMemoryCatalogWorkerRuntime(store)
    const port = new FakePort()
    await runtime.handleMessage({
      data: { type: 'IN_MEMORY_CATALOG_OPEN_WORKSPACE_SESSION', workspace_id: 'workspace' },
      ports: [port],
    })
    await port.dispatch({
      type: 'IN_MEMORY_CATALOG_REPLACE_SNAPSHOT',
      request_id: 'replace-max',
      catalog_revision: (1n << 64n) - 1n,
      snapshot: snapshot(),
    })

    await port.dispatch({
      type: 'IN_MEMORY_CATALOG_DROP_WORKSPACE',
      request_id: 'drop-1',
    })

    assert.deepEqual(port.messages.at(-1), {
      type: 'IN_MEMORY_CATALOG_DROP_WORKSPACE_RESULT',
      request_id: 'drop-1',
      ok: true,
      dropped: true,
    })
    assert.equal(port.closed, true)
    assert.equal(store.diagnostics().active_workspace_session_count, 0)
  })

  it('rejects a second active writer without replacing the first session', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const runtime = createInMemoryCatalogWorkerRuntime(store)
    const first = new FakePort()
    const second = new FakePort()

    await runtime.handleMessage({
      data: { type: 'IN_MEMORY_CATALOG_OPEN_WORKSPACE_SESSION', workspace_id: 'workspace' },
      ports: [first],
    })
    await runtime.handleMessage({
      data: { type: 'IN_MEMORY_CATALOG_OPEN_WORKSPACE_SESSION', workspace_id: 'workspace' },
      ports: [second],
    })

    assert.equal(first.closed, false)
    assert.deepEqual(second.messages, [{
      type: 'IN_MEMORY_CATALOG_WORKSPACE_SESSION_OPENED',
      ok: false,
      code: 'RC_CATALOG_WORKSPACE_ALREADY_ACTIVE',
      message: 'Catalog workspace already has an active writer',
    }])
    assert.equal(second.closed, true)
  })
})
