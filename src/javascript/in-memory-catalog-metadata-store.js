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
  const SUPPORTED_SCANNERS = new Set(['parquet', 'csv'])
  const CSV_SCANNER_OPTION_TYPES = Object.freeze({
    auto_detect: 'boolean',
    header: 'boolean',
    delimiter: 'string',
    quote: 'string',
    escape: 'string',
    comment: 'string',
    skip: 'nonnegative_integer',
    nullstr: 'string',
    all_varchar: 'boolean',
    normalize_names: 'boolean',
    dateformat: 'string',
    timestampformat: 'string',
    compression: 'string',
    ignore_errors: 'boolean',
    null_padding: 'boolean',
  })
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

      const replaceCatalogSnapshot = (snapshot) => {
        if (record.closing) return Promise.reject(closedWorkspaceError())
        let candidate
        try {
          // Capture the caller's state before waiting for earlier publications.
          candidate = normalizeSnapshot(snapshot)
        } catch (error) {
          return Promise.reject(error)
        }
        const operation = record.pending.then(() => {
          // Internal generation: DuckDB cache invalidation and bridge consistency only.
          // Application state ordering follows publication order, not this counter.
          const revision = (record.current?.revision ?? 0n) + 1n
          if (revision > MAX_UINT64) {
            throw new InMemoryCatalogError(
              'RC_METADATA_GENERATION_EXHAUSTED',
              'Catalog internal generation is exhausted; reopen the workspace',
            )
          }
          // Validate the complete candidate before atomically replacing current state.
          record.current = Object.freeze({ revision, ...candidate })
        })
        record.pending = operation.catch(() => {})
        return operation
      }

      const replaceCatalogTable = (schemaName, table) => {
        if (record.closing) return Promise.reject(closedWorkspaceError())
        let normalizedSchemaName
        let candidate
        try {
          normalizedSchemaName = requireName(schemaName, 'schema_name')
          // Capture and validate only the submitted table before waiting for
          // earlier queued publications. Target lookup happens in the queued
          // operation so mixed full and table replacements observe order.
          candidate = normalizeTable(table, 'table', new Set())
        } catch (error) {
          return Promise.reject(error)
        }
        const operation = record.pending.then(() => {
          const current = record.current
          const schema = current?.schemas.get(indexKey(normalizedSchemaName))
          if (!schema) {
            throw new InMemoryCatalogError(
              'RC_CATALOG_SCHEMA_NOT_FOUND',
              `Catalog schema ${normalizedSchemaName} was not found`,
            )
          }

          const tableKey = indexKey(candidate.name)
          const previousTable = schema.tables.get(tableKey)
          if (!previousTable) {
            throw new InMemoryCatalogError(
              'RC_CATALOG_TABLE_NOT_FOUND',
              `Catalog table ${normalizedSchemaName}.${candidate.name} was not found`,
            )
          }

          // A case-insensitive table match addresses the existing table. Keep
          // its published spelling while replacing its validated contents.
          const replacement = deepFreeze({ ...candidate, name: previousTable.name })
          const tables = schema.metadata.tables.slice()
          tables[schema.tablePositions.get(tableKey)] = replacement
          const metadata = deepFreeze({ name: schema.metadata.name, tables })
          const replacementMetadata = current.snapshot.format_version === 3
            ? deepFreeze({ name: schema.metadata.name, tables, views: schema.metadata.views })
            : metadata
          const tableIndex = new Map(schema.tables)
          tableIndex.set(tableKey, replacement)
          const replacementSchema = Object.freeze({
            metadata: replacementMetadata,
            tables: tableIndex,
            tablePositions: schema.tablePositions,
            views: schema.views,
            viewPositions: schema.viewPositions,
          })

          const schemas = current.snapshot.schemas.slice()
          schemas[current.schemaPositions.get(indexKey(schema.metadata.name))] = replacementMetadata
          const snapshot = makeSnapshot(current.snapshot.format_version, schemas)
          const schemaIndex = new Map(current.schemas)
          schemaIndex.set(indexKey(schema.metadata.name), replacementSchema)

          // Internal generation: DuckDB cache invalidation and bridge consistency only.
          // Application state ordering follows publication order, not this counter.
          const revision = (current.revision ?? 0n) + 1n
          if (revision > MAX_UINT64) {
            throw new InMemoryCatalogError(
              'RC_METADATA_GENERATION_EXHAUSTED',
              'Catalog internal generation is exhausted; reopen the workspace',
            )
          }
          record.current = Object.freeze({
            revision,
            snapshot,
            schemas: schemaIndex,
            schemaPositions: current.schemaPositions,
          })
        })
        record.pending = operation.catch(() => {})
        return operation
      }

      const replaceCatalogView = (schemaName, view) => {
        if (record.closing) return Promise.reject(closedWorkspaceError())
        let normalizedSchemaName
        let candidate
        try {
          normalizedSchemaName = requireName(schemaName, 'schema_name')
          candidate = normalizeView(view, 'view', new Set())
        } catch (error) {
          return Promise.reject(error)
        }
        const operation = record.pending.then(() => {
          const current = record.current
          const schema = current?.schemas.get(indexKey(normalizedSchemaName))
          if (!schema) {
            throw new InMemoryCatalogError(
              'RC_CATALOG_SCHEMA_NOT_FOUND',
              `Catalog schema ${normalizedSchemaName} was not found`,
            )
          }

          const viewKey = indexKey(candidate.name)
          const previousView = schema.views.get(viewKey)
          if (!previousView) {
            throw new InMemoryCatalogError(
              'RC_CATALOG_VIEW_NOT_FOUND',
              `Catalog view ${normalizedSchemaName}.${candidate.name} was not found`,
            )
          }

          const replacement = deepFreeze({ ...candidate, name: previousView.name })
          const views = schema.metadata.views.slice()
          views[schema.viewPositions.get(viewKey)] = replacement
          const metadata = deepFreeze({
            name: schema.metadata.name,
            tables: schema.metadata.tables,
            views,
          })
          const viewIndex = new Map(schema.views)
          viewIndex.set(viewKey, replacement)
          const replacementSchema = Object.freeze({
            metadata,
            tables: schema.tables,
            tablePositions: schema.tablePositions,
            views: viewIndex,
            viewPositions: schema.viewPositions,
          })

          const schemas = current.snapshot.schemas.slice()
          schemas[current.schemaPositions.get(indexKey(schema.metadata.name))] = metadata
          const snapshot = makeSnapshot(3, schemas)
          const schemaIndex = new Map(current.schemas)
          schemaIndex.set(indexKey(schema.metadata.name), replacementSchema)

          const revision = (current.revision ?? 0n) + 1n
          if (revision > MAX_UINT64) {
            throw new InMemoryCatalogError(
              'RC_METADATA_GENERATION_EXHAUSTED',
              'Catalog internal generation is exhausted; reopen the workspace',
            )
          }
          record.current = Object.freeze({
            revision,
            snapshot,
            schemas: schemaIndex,
            schemaPositions: current.schemaPositions,
          })
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
        replaceCatalogTable,
        replaceCatalogView,
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

    lookupView(workspaceId, revision, schemaName, viewName) {
      this.#fullLookupCount += 1
      return this.#snapshotAtRevision(workspaceId, revision)
        ?.schemas.get(indexKey(schemaName))?.views.get(indexKey(viewName))
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

    listViews(workspaceId, revision, schemaName) {
      const schema = this.#snapshotAtRevision(workspaceId, revision)
        ?.schemas.get(indexKey(schemaName))
      return schema ? (schema.metadata.views ?? []).map((view) => ({
        name: view.name,
        query: view.query,
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

  function normalizeSnapshot(input) {
    if (!isRecord(input)) invalid('snapshot must be an object')
    if (input.format_version !== 2 && input.format_version !== 3) {
      throw new InMemoryCatalogError(
        'RC_METADATA_VERSION',
        'Catalog snapshot format_version must be 2 or 3',
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
      if (input.format_version === 2 && (!Array.isArray(schema.tables) || schema.tables.length === 0)) {
        invalid(`schema ${name} must contain at least one table`)
      }
      if (input.format_version === 2 && schema.views !== undefined) {
        throw new InMemoryCatalogError(
          'RC_METADATA_VERSION',
          'Catalog views require snapshot format_version 3',
        )
      }
      const rawTables = schema.tables === undefined ? [] : schema.tables
      const rawViews = schema.views === undefined ? [] : schema.views
      if (!Array.isArray(rawTables)) invalid(`schema ${name}.tables must be an array`)
      if (!Array.isArray(rawViews)) invalid(`schema ${name}.views must be an array`)
      if (input.format_version === 3 && rawTables.length + rawViews.length === 0) {
        invalid(`schema ${name} must contain at least one table or view`)
      }

      const relationNames = new Set()
      const tableIndex = new Map()
      const tablePositions = new Map()
      const tables = rawTables.map((table, tableIndexValue) => {
        const normalized = normalizeTable(
          table,
          `${path}.tables[${tableIndexValue}]`,
          relationNames,
        )
        tableIndex.set(indexKey(normalized.name), normalized)
        tablePositions.set(indexKey(normalized.name), tableIndexValue)
        return normalized
      })
      const viewIndex = new Map()
      const viewPositions = new Map()
      const views = rawViews.map((view, viewIndexValue) => {
        const normalized = normalizeView(
          view,
          `${path}.views[${viewIndexValue}]`,
          relationNames,
        )
        viewIndex.set(indexKey(normalized.name), normalized)
        viewPositions.set(indexKey(normalized.name), viewIndexValue)
        return normalized
      })
      const metadata = input.format_version === 3
        ? deepFreeze({ name, tables, views })
        : deepFreeze({ name, tables })
      schemaIndex.set(indexKey(name), Object.freeze({
        metadata,
        tables: tableIndex,
        tablePositions,
        views: viewIndex,
        viewPositions,
      }))
      return metadata
    })

    const schemaPositions = new Map(
      normalizedSchemas.map((schema, schemaIndexValue) => [indexKey(schema.name), schemaIndexValue]),
    )

    return {
      snapshot: makeSnapshot(input.format_version, normalizedSchemas),
      schemas: schemaIndex,
      schemaPositions,
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

  function normalizeView(input, path, relationNames) {
    if (!isRecord(input) || !hasExactKeys(input, ['name', 'query'])) {
      invalid(`${path} must contain only name and query`)
    }
    const name = uniqueName(input.name, relationNames, `${path}.name`)
    const query = requireName(input.query, `${path}.query`)
    if (query.trim().length === 0) invalid(`${path}.query must not be empty`)
    return deepFreeze({ name, query })
  }

  function makeSnapshot(formatVersion, schemas) {
    return deepFreeze({ format_version: formatVersion, schemas })
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
    if (type === 'parquet') {
      if (Object.keys(input.options).length !== 0) {
        invalid(`${path}.options must be empty for parquet`)
      }
      return deepFreeze({ type, options: {} })
    }

    const options = {}
    for (const [key, value] of Object.entries(input.options)) {
      const expectedType = CSV_SCANNER_OPTION_TYPES[key]
      if (!expectedType) {
        invalid(`${path}.options.${key} is not supported for csv`)
      }
      if (expectedType === 'boolean' && typeof value !== 'boolean') {
        invalid(`${path}.options.${key} must be boolean`)
      }
      if (expectedType === 'string' &&
          (typeof value !== 'string' || value.length === 0 || value.includes('\0'))) {
        invalid(`${path}.options.${key} must be a non-empty string without NUL`)
      }
      if (expectedType === 'nonnegative_integer' &&
          (!Number.isSafeInteger(value) || value < 0)) {
        invalid(`${path}.options.${key} must be a non-negative safe integer`)
      }
      options[key] = value
    }
    return deepFreeze({ type, options })
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
