import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

await import('../../src/javascript/in-memory-catalog-metadata-store.js')
await import('../../src/javascript/in-memory-catalog-worker-runtime.js')

const { InMemoryCatalogMetadataStore } = globalThis.DuckDBInMemoryCatalogMetadata
const { createInMemoryCatalogWorkerRuntime } = globalThis.DuckDBInMemoryCatalogWorkerRuntime

function snapshot(uri = 'https://example.test/table') {
  return {
    format_version: 2,
    schemas: [{
      name: 'main',
      tables: [{
        name: 'table1',
        snapshot: 'snapshot-1',
        scanner: { type: 'parquet', options: {} },
        columns: [{ name: 'id', type: 'BIGINT', nullable: false }],
        files: [{ uri }],
      }],
    }],
  }
}

function viewSnapshot() {
  return {
    format_version: 3,
    schemas: [{
      name: 'main',
      tables: [{
        name: 'table1',
        snapshot: 'snapshot-1',
        scanner: { type: 'parquet', options: {} },
        columns: [{ name: 'id', type: 'BIGINT', nullable: false }],
        files: [{ uri: 'https://example.test/table' }],
      }],
      views: [{ name: 'view1', query: 'SELECT id FROM table1' }],
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
  it('opens a dedicated session and exposes file descriptors to the current scanner implementation', async () => {
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
      snapshot: snapshot(),
    })

    assert.deepEqual(port.messages, [
      { type: 'IN_MEMORY_CATALOG_WORKSPACE_SESSION_OPENED', ok: true },
      {
        type: 'IN_MEMORY_CATALOG_REPLACE_SNAPSHOT_RESULT',
        request_id: 'replace-1',
        ok: true,
      },
    ])
    assert.equal(runtime.bridge.currentRevision('workspace'), '1')
    assert.deepEqual(
      JSON.parse(runtime.bridge.lookupTable('workspace', '1', 'main', 'table1')).files,
      [{ uri: 'https://example.test/table' }],
    )
    assert.deepEqual(
      JSON.parse(runtime.bridge.lookupTable('workspace', '1', 'main', 'table1')).scanner,
      { type: 'parquet', options: {} },
    )
    await port.dispatch({
      type: 'IN_MEMORY_CATALOG_GET_DIAGNOSTICS',
      request_id: 'diagnostics-1',
    })
    assert.equal(port.messages.at(-1).diagnostics.full_lookup_count, 2)
  })

  it('transfers csv scanner options through the Worker bridge', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const runtime = createInMemoryCatalogWorkerRuntime(store)
    const port = new FakePort()
    await runtime.handleMessage({
      data: { type: 'IN_MEMORY_CATALOG_OPEN_WORKSPACE_SESSION', workspace_id: 'workspace' },
      ports: [port],
    })
    const candidate = snapshot()
    candidate.schemas[0].tables[0].scanner = {
      type: 'csv',
      options: { delimiter: '\t', header: true, skip: 1 },
    }
    await port.dispatch({
      type: 'IN_MEMORY_CATALOG_REPLACE_SNAPSHOT',
      request_id: 'replace-csv-1',
      snapshot: candidate,
    })

    assert.deepEqual(
      JSON.parse(runtime.bridge.lookupTable('workspace', '1', 'main', 'table1')).scanner,
      candidate.schemas[0].tables[0].scanner,
    )
  })

  it('transfers json scanner options and nested types through the Worker bridge', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const runtime = createInMemoryCatalogWorkerRuntime(store)
    const port = new FakePort()
    await runtime.handleMessage({
      data: { type: 'IN_MEMORY_CATALOG_OPEN_WORKSPACE_SESSION', workspace_id: 'workspace' },
      ports: [port],
    })
    const candidate = snapshot()
    candidate.schemas[0].tables[0].scanner = {
      type: 'json',
      options: { format: 'array', records: 'true' },
    }
    candidate.schemas[0].tables[0].columns = [
      { name: 'payload', type: 'STRUCT(id BIGINT, tags VARCHAR[], raw JSON)', nullable: true },
    ]
    await port.dispatch({
      type: 'IN_MEMORY_CATALOG_REPLACE_SNAPSHOT',
      request_id: 'replace-json-1',
      snapshot: candidate,
    })

    const descriptor = JSON.parse(runtime.bridge.lookupTable('workspace', '1', 'main', 'table1'))
    assert.deepEqual(descriptor.scanner, candidate.schemas[0].tables[0].scanner)
    assert.deepEqual(descriptor.columns, candidate.schemas[0].tables[0].columns)
  })

  it('acknowledges a dedicated table replacement without exposing a revision', async () => {
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
      snapshot: snapshot(),
    })

    const replacement = snapshot('https://example.test/table-update').schemas[0].tables[0]
    replacement.snapshot = 'snapshot-update'
    await port.dispatch({
      type: 'IN_MEMORY_CATALOG_REPLACE_TABLE',
      request_id: 'replace-table-1',
      schema_name: 'MAIN',
      table: replacement,
    })

    assert.deepEqual(port.messages.at(-1), {
      type: 'IN_MEMORY_CATALOG_REPLACE_TABLE_RESULT',
      request_id: 'replace-table-1',
      ok: true,
    })
    assert.equal('revision' in port.messages.at(-1), false)
    assert.equal(runtime.bridge.currentRevision('workspace'), '2')
    assert.equal(
      JSON.parse(runtime.bridge.lookupTable('workspace', '2', 'main', 'table1')).snapshot,
      'snapshot-update',
    )
  })

  it('exposes view descriptors and acknowledges a dedicated view replacement', async () => {
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
      snapshot: viewSnapshot(),
    })

    assert.deepEqual(JSON.parse(runtime.bridge.listViews('workspace', '1', 'main')), [
      { name: 'view1', query: 'SELECT id FROM table1' },
    ])
    assert.deepEqual(JSON.parse(runtime.bridge.lookupView('workspace', '1', 'main', 'VIEW1')), {
      catalog_revision: '1',
      schema_name: 'main',
      view_name: 'VIEW1',
      query: 'SELECT id FROM table1',
    })

    await port.dispatch({
      type: 'IN_MEMORY_CATALOG_REPLACE_VIEW',
      request_id: 'replace-view-1',
      schema_name: 'MAIN',
      view: { name: 'VIEW1', query: 'SELECT id FROM table1 WHERE id > 1' },
    })
    assert.deepEqual(port.messages.at(-1), {
      type: 'IN_MEMORY_CATALOG_REPLACE_VIEW_RESULT',
      request_id: 'replace-view-1',
      ok: true,
    })
    assert.equal(JSON.parse(runtime.bridge.lookupView('workspace', '2', 'main', 'view1')).query,
      'SELECT id FROM table1 WHERE id > 1')
  })

  it('drops a published workspace before acknowledging and closes the port', async () => {
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
