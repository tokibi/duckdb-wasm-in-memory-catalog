(function initializeInMemoryCatalogMetadata(global) {
  'use strict'

  const SUPPORTED_TYPES = new Set([
    'BOOLEAN',
    'TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT',
    'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT',
    'FLOAT', 'DOUBLE',
    'VARCHAR',
    'DATE', 'TIMESTAMP', 'TIMESTAMP_TZ',
  ])
  const SUPPORTED_SCANNERS = new Set(['parquet'])
  const DECIMAL_REVISION_PATTERN = /^(0|[1-9][0-9]*)$/
  const MAX_UINT64 = (1n << 64n) - 1n

  class InMemoryCatalogError extends Error {
    constructor(code, message) {
      super(message)
      this.name = 'InMemoryCatalogError'
      this.code = code
    }
  }

  class InMemoryCatalogMetadataStore {
    #sessions = new Map()
    #fullLookupCount = 0
    #uriDescriptorTransferCount = 0

    openWorkspaceSession(workspaceId) {
      const normalizedWorkspaceId = requireName(workspaceId, 'workspace_id')
      if (this.#sessions.has(normalizedWorkspaceId)) {
        throw new InMemoryCatalogError(
          'RC_CATALOG_WORKSPACE_ALREADY_ACTIVE',
          `Catalog workspace ${normalizedWorkspaceId} already has an active writer`,
        )
      }

      const record = {
        workspaceId: normalizedWorkspaceId,
        current: undefined,
        pending: Promise.resolve(),
        closing: false,
      }
      this.#sessions.set(normalizedWorkspaceId, record)

      const replaceCatalogSnapshot = (revision, snapshot) => {
        if (record.closing) return Promise.reject(closedWorkspaceError())
        const operation = record.pending.then(async () => {
          const candidate = await buildCandidate(revision, snapshot)
          const current = record.current
          if (current && candidate.revision < current.revision) {
            throw new InMemoryCatalogError(
              'RC_METADATA_STALE',
              `Catalog revision ${candidate.revision} is older than current revision ${current.revision}`,
            )
          }
          if (current && candidate.revision === current.revision) {
            if (candidate.fingerprint !== current.fingerprint) {
              throw new InMemoryCatalogError(
                'RC_METADATA_REVISION_CONFLICT',
                `Catalog revision ${candidate.revision} already has different metadata`,
              )
            }
            return { revision: candidate.revision.toString(), idempotent: true }
          }
          record.current = candidate
          return { revision: candidate.revision.toString(), idempotent: false }
        })
        record.pending = operation.catch(() => {})
        return operation
      }

      const dropCatalogWorkspace = () => {
        if (record.closing) return Promise.reject(closedWorkspaceError())
        record.closing = true
        const operation = record.pending.then(() => {
          this.#sessions.delete(normalizedWorkspaceId)
          record.current = undefined
          return { dropped: true }
        })
        record.pending = operation.catch(() => {})
        return operation
      }

      return Object.freeze({
        replaceCatalogSnapshot,
        dropCatalogWorkspace,
        diagnostics: () => this.diagnostics(),
      })
    }

    currentRevision(workspaceId) {
      return this.#sessions.get(workspaceId)?.current?.revision
    }

    hasWorkspace(workspaceId) {
      return this.#sessions.has(workspaceId)
    }

    lookupTable(workspaceId, revision, schemaName, tableName) {
      this.#fullLookupCount += 1
      const table = this.#snapshotAtRevision(workspaceId, revision)
        ?.schemas.get(indexKey(schemaName))?.tables.get(indexKey(tableName))
      if (table) this.#uriDescriptorTransferCount += table.files.length
      return table
    }

    listSchemas(workspaceId, revision) {
      const published = this.#snapshotAtRevision(workspaceId, revision)
      return published ? published.snapshot.schemas.map((schema) => schema.name) : []
    }

    listTables(workspaceId, revision, schemaName) {
      const schema = this.#snapshotAtRevision(workspaceId, revision)
        ?.schemas.get(indexKey(schemaName))
      return schema ? schema.metadata.tables.map((table) => ({
        name: table.name,
        columns: table.columns,
      })) : []
    }

    diagnostics() {
      let snapshotCount = 0
      for (const session of this.#sessions.values()) {
        if (session.current) snapshotCount += 1
      }
      return {
        active_workspace_session_count: this.#sessions.size,
        retained_workspace_snapshot_count: snapshotCount,
        retained_catalog_revision_state: snapshotCount,
        full_lookup_count: this.#fullLookupCount,
        uri_descriptor_transfer_count: this.#uriDescriptorTransferCount,
      }
    }

    #snapshotAtRevision(workspaceId, revision) {
      const published = this.#sessions.get(workspaceId)?.current
      if (!published) return undefined
      const expectedRevision = parseBridgeRevision(revision)
      if (published.revision !== expectedRevision) {
        throw new InMemoryCatalogError(
          'RC_METADATA_REVISION_CHANGED',
          `Catalog revision changed from ${expectedRevision} to ${published.revision}`,
        )
      }
      return published
    }
  }

  async function buildCandidate(revision, snapshotInput) {
    const normalizedRevision = parsePublicRevision(revision)
    const { snapshot, schemas } = normalizeSnapshot(snapshotInput)
    const fingerprint = await sha256(JSON.stringify(snapshot))
    return Object.freeze({ revision: normalizedRevision, fingerprint, snapshot, schemas })
  }

  function normalizeSnapshot(input) {
    if (!isRecord(input)) invalid('snapshot must be an object')
    if (input.format_version !== 2) {
      throw new InMemoryCatalogError(
        'RC_METADATA_VERSION',
        'Catalog snapshot format_version must be 2',
      )
    }
    if (!Array.isArray(input.schemas) || input.schemas.length === 0) {
      invalid('snapshot.schemas must contain at least one schema')
    }

    const schemaNames = new Set()
    const schemaIndex = new Map()
    const normalizedSchemas = input.schemas.map((schema, schemaIndexValue) => {
      const path = `schemas[${schemaIndexValue}]`
      if (!isRecord(schema)) invalid(`${path} must be an object`)
      const name = uniqueName(schema.name, schemaNames, `${path}.name`)
      if (!Array.isArray(schema.tables) || schema.tables.length === 0) {
        invalid(`schema ${name} must contain at least one table`)
      }

      const tableNames = new Set()
      const tableIndex = new Map()
      const tables = schema.tables.map((table, tableIndexValue) => {
        const normalized = normalizeTable(
          table,
          `${path}.tables[${tableIndexValue}]`,
          tableNames,
        )
        tableIndex.set(indexKey(normalized.name), normalized)
        return normalized
      })
      const metadata = deepFreeze({ name, tables })
      schemaIndex.set(indexKey(name), Object.freeze({ metadata, tables: tableIndex }))
      return metadata
    })

    return {
      snapshot: deepFreeze({ format_version: 2, schemas: normalizedSchemas }),
      schemas: schemaIndex,
    }
  }

  function normalizeTable(input, path, tableNames) {
    if (!isRecord(input)) invalid(`${path} must be an object`)
    const name = uniqueName(input.name, tableNames, `${path}.name`)
    const snapshot = requireName(input.snapshot, `${path}.snapshot`)
    const scanner = normalizeScanner(input.scanner, `${path}.scanner`)
    if (!Array.isArray(input.columns) || input.columns.length === 0) {
      invalid(`${path}.columns must contain at least one column`)
    }
    if (!Array.isArray(input.files) || input.files.length === 0) {
      invalid(`${path}.files must contain at least one URI`)
    }

    const columnNames = new Set()
    const columns = input.columns.map((column, index) => {
      const columnPath = `${path}.columns[${index}]`
      if (!isRecord(column)) invalid(`${columnPath} must be an object`)
      const columnName = uniqueName(column.name, columnNames, `${columnPath}.name`)
      if (typeof column.type !== 'string' || !SUPPORTED_TYPES.has(column.type)) {
        invalid(`${columnPath}.type is unsupported`)
      }
      if (typeof column.nullable !== 'boolean') invalid(`${columnPath}.nullable must be boolean`)
      return deepFreeze({ name: columnName, type: column.type, nullable: column.nullable })
    })

    const uris = new Set()
    const files = input.files.map((file, index) => {
      const filePath = `${path}.files[${index}]`
      if (!isRecord(file) || !hasExactKeys(file, ['uri'])) {
        invalid(`${filePath} must contain only uri`)
      }
      const uri = requireName(file.uri, `${filePath}.uri`)
      if (uris.has(uri)) invalid(`${filePath}.uri is duplicated`)
      uris.add(uri)
      return deepFreeze({ uri })
    })

    return deepFreeze({ name, snapshot, scanner, columns, files })
  }

  function normalizeScanner(input, path) {
    if (!isRecord(input) || !hasExactKeys(input, ['type', 'options'])) {
      invalid(`${path} must contain type and options`)
    }
    const type = requireName(input.type, `${path}.type`)
    if (!SUPPORTED_SCANNERS.has(type)) {
      throw new InMemoryCatalogError(
        'RC_SCANNER_UNSUPPORTED',
        `Scanner type ${type} is not supported`,
      )
    }
    if (!isRecord(input.options)) {
      invalid(`${path}.options must be an object`)
    }
    if (type === 'parquet' && Object.keys(input.options).length !== 0) {
      invalid(`${path}.options must be empty for parquet`)
    }
    return deepFreeze({ type, options: {} })
  }

  function parsePublicRevision(value) {
    if (typeof value === 'bigint' && value >= 0n && value <= MAX_UINT64) return value
    invalid('Catalog revision must be a bigint in uint64 range')
  }

  function parseBridgeRevision(value) {
    if (typeof value === 'bigint' && value >= 0n && value <= MAX_UINT64) return value
    if (typeof value === 'string' && DECIMAL_REVISION_PATTERN.test(value)) {
      const revision = BigInt(value)
      if (revision <= MAX_UINT64) return revision
    }
    invalid('Catalog bridge revision must be a uint64 decimal string')
  }

  function uniqueName(value, names, path) {
    const name = requireName(value, path)
    const key = indexKey(name)
    if (names.has(key)) invalid(`${path} is duplicated`)
    names.add(key)
    return name
  }

  function requireName(value, path) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
      invalid(`${path} must be a non-empty string without NUL`)
    }
    return value
  }

  function indexKey(name) {
    return name.toLowerCase()
  }

  function hasExactKeys(value, expected) {
    const keys = Object.keys(value)
    return keys.length === expected.length && expected.every((key) => keys.includes(key))
  }

  function deepFreeze(value) {
    Object.freeze(value)
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) deepFreeze(nested)
    }
    return value
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(value)
    const digest = await global.crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  function closedWorkspaceError() {
    return new InMemoryCatalogError(
      'RC_CATALOG_WORKSPACE_CLOSED',
      'Catalog workspace session is closed',
    )
  }

  function invalid(message) {
    throw new InMemoryCatalogError('RC_METADATA_INVALID', message)
  }

  global.DuckDBInMemoryCatalogMetadata = Object.freeze({
    InMemoryCatalogError,
    InMemoryCatalogMetadataStore,
  })
})(globalThis)
