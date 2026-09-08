import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

await import('../../src/javascript/in-memory-catalog-metadata-store.js')

const {
  InMemoryCatalogError,
  InMemoryCatalogMetadataStore,
} = globalThis.DuckDBInMemoryCatalogMetadata

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

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof InMemoryCatalogError)
    assert.equal(error.code, code)
    return true
  })
}

describe('InMemoryCatalogMetadataStore', () => {
  it('publishes URI-only metadata and keeps enumeration descriptors lightweight', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const session = store.openWorkspaceSession('workspace')

    await session.replaceCatalogSnapshot(1n, snapshot())

    assert.equal(store.currentRevision('workspace'), 1n)
    assert.deepEqual(store.listSchemas('workspace', '1'), ['main'])
    assert.deepEqual(store.listTables('workspace', '1', 'main'), [{
      name: 'table1',
      columns: [{ name: 'id', type: 'BIGINT', nullable: false }],
    }])
    assert.deepEqual(store.lookupTable('workspace', '1', 'main', 'table1').files, [
      { uri: 'https://example.test/table.parquet' },
    ])
    assert.doesNotMatch(JSON.stringify(store.listTables('workspace', '1', 'main')), /uri|files/)
  })

  it('enumerates 100,000 tables without full lookup or URI transfer', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const session = store.openWorkspaceSession('workspace')
    const candidate = snapshot()
    const template = candidate.schemas[0].tables[0]
    candidate.schemas[0].tables = Array.from({ length: 100_000 }, (_, index) => ({
      ...structuredClone(template),
      name: `table${index + 1}`,
    }))

    await session.replaceCatalogSnapshot(1n, candidate)
    const tables = store.listTables('workspace', '1', 'main')

    assert.equal(tables.length, 100_000)
    assert.deepEqual(store.diagnostics(), {
      active_workspace_session_count: 1,
      retained_workspace_snapshot_count: 1,
      retained_catalog_revision_state: 1,
      full_lookup_count: 0,
      uri_descriptor_transfer_count: 0,
    })
  })

  it('rejects legacy object metadata and duplicate URIs atomically', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const session = store.openWorkspaceSession('workspace')
    const legacy = snapshot()
    legacy.schemas[0].tables[0].files[0].hash = `sha256:${'a'.repeat(64)}`

    await expectCode(
      () => session.replaceCatalogSnapshot(1n, legacy),
      'RC_METADATA_INVALID',
    )
    assert.equal(store.hasWorkspace('workspace'), true)
    assert.equal(store.currentRevision('workspace'), undefined)

    const duplicate = snapshot()
    duplicate.schemas[0].tables[0].files.push({
      uri: 'https://example.test/table.parquet',
    })
    await expectCode(
      () => session.replaceCatalogSnapshot(1n, duplicate),
      'RC_METADATA_INVALID',
    )
  })

  it('enforces one writer and releases all workspace state on revisionless drop', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const session = store.openWorkspaceSession('workspace')

    assert.throws(
      () => store.openWorkspaceSession('workspace'),
      (error) => error.code === 'RC_CATALOG_WORKSPACE_ALREADY_ACTIVE',
    )
    await session.replaceCatalogSnapshot((1n << 64n) - 1n, snapshot())
    await session.dropCatalogWorkspace()

    assert.deepEqual(store.diagnostics(), {
      active_workspace_session_count: 0,
      retained_workspace_snapshot_count: 0,
      retained_catalog_revision_state: 0,
      full_lookup_count: 0,
      uri_descriptor_transfer_count: 0,
    })
    await expectCode(
      () => session.replaceCatalogSnapshot(1n, snapshot()),
      'RC_CATALOG_WORKSPACE_CLOSED',
    )

    const replacement = store.openWorkspaceSession('workspace')
    await replacement.replaceCatalogSnapshot(0n, snapshot())
    assert.equal(store.currentRevision('workspace'), 0n)
  })

  it('drops after a rejected pending replacement instead of leaking the session', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const session = store.openWorkspaceSession('workspace')
    const invalid = snapshot()
    invalid.schemas[0].tables[0].files = []

    await expectCode(
      () => session.replaceCatalogSnapshot(1n, invalid),
      'RC_METADATA_INVALID',
    )
    await session.dropCatalogWorkspace()

    assert.equal(store.diagnostics().active_workspace_session_count, 0)
  })
})
