import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

await import('../../src/javascript/in-memory-catalog-metadata-store.js')

const {
  InMemoryCatalogError,
  InMemoryCatalogMetadataStore,
} = globalThis.DuckDBInMemoryCatalogMetadata

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

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof InMemoryCatalogError)
    assert.equal(error.code, code)
    return true
  })
}

describe('InMemoryCatalogMetadataStore', () => {
  it('publishes scanner and URI metadata while keeping enumeration descriptors lightweight', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const session = store.openWorkspaceSession('workspace')

    await session.replaceCatalogSnapshot(1n, snapshot())

    assert.equal(store.currentRevision('workspace'), 1n)
    assert.deepEqual(store.listSchemas('workspace', '1'), ['main'])
    assert.deepEqual(store.listTables('workspace', '1', 'main'), [{
      name: 'table1',
      columns: [{ name: 'id', type: 'BIGINT', nullable: false }],
    }])
    const table = store.lookupTable('workspace', '1', 'main', 'table1')
    assert.deepEqual(table.scanner, { type: 'parquet', options: {} })
    assert.deepEqual(table.files, [{ uri: 'https://example.test/table' }])
    assert.doesNotMatch(JSON.stringify(store.listTables('workspace', '1', 'main')), /uri|files|scanner/)
  })

  it('keeps host file URIs stable when only the table snapshot changes', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const session = store.openWorkspaceSession('workspace')

    const firstSnapshot = snapshot('https://example.test/stable-file')
    await session.replaceCatalogSnapshot(1n, firstSnapshot)
    const firstTable = store.lookupTable('workspace', '1', 'main', 'table1')

    const secondSnapshot = snapshot('https://example.test/stable-file')
    secondSnapshot.schemas[0].tables[0].snapshot = 'snapshot-2'
    await session.replaceCatalogSnapshot(2n, secondSnapshot)
    const secondTable = store.lookupTable('workspace', '2', 'main', 'table1')

    assert.deepEqual(firstTable.files, [{ uri: 'https://example.test/stable-file' }])
    assert.deepEqual(secondTable.files, [{ uri: 'https://example.test/stable-file' }])
    assert.equal(firstTable.snapshot, 'snapshot-1')
    assert.equal(secondTable.snapshot, 'snapshot-2')
  })

  it('requires an explicit supported scanner in format version 2', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const session = store.openWorkspaceSession('workspace')

    const missing = snapshot()
    delete missing.schemas[0].tables[0].scanner
    await expectCode(
      () => session.replaceCatalogSnapshot(1n, missing),
      'RC_METADATA_INVALID',
    )

    const unsupported = snapshot()
    unsupported.schemas[0].tables[0].scanner.type = 'csv'
    await expectCode(
      () => session.replaceCatalogSnapshot(1n, unsupported),
      'RC_SCANNER_UNSUPPORTED',
    )

    const options = snapshot()
    options.schemas[0].tables[0].scanner.options = { hive_partitioning: true }
    await expectCode(
      () => session.replaceCatalogSnapshot(1n, options),
      'RC_METADATA_INVALID',
    )

    assert.equal(store.currentRevision('workspace'), undefined)
  })

  it('rejects the previous snapshot format instead of choosing a scanner implicitly', async () => {
    const store = new InMemoryCatalogMetadataStore()
    const session = store.openWorkspaceSession('workspace')
    const legacy = snapshot()
    legacy.format_version = 1

    await expectCode(
      () => session.replaceCatalogSnapshot(1n, legacy),
      'RC_METADATA_VERSION',
    )
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

  it('rejects extra file metadata and duplicate URIs atomically', async () => {
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
      uri: 'https://example.test/table',
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
