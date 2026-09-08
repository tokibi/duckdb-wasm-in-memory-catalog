import * as duckdb from './duckdb/duckdb-browser.mjs'
import { InMemoryCatalogController } from './in-memory-catalog/in-memory-catalog-controller.mjs'

const runButton = document.querySelector('#run-demo')
const resetButton = document.querySelector('#reset-demo')
const statusText = document.querySelector('#demo-status')
const catalogNameInput = document.querySelector('#catalog-name')
const catalogEditor = document.querySelector('#catalog-editor')
const sqlEditor = document.querySelector('#sql-editor')
const resultHead = document.querySelector('#result-head')
const resultBody = document.querySelector('#result-body')
const resultSummary = document.querySelector('#result-summary')
const fixtureUrlValue = document.querySelector('#fixture-url')
const fixtureRowsValue = document.querySelector('#fixture-rows')
const fixtureBytesValue = document.querySelector('#fixture-bytes')
const fixtureColumnsValue = document.querySelector('#fixture-columns')
const logOutput = document.querySelector('#diagnostics')
const steps = new Map(
  [...document.querySelectorAll('[data-step]')].map((element) => [element.dataset.step, element]),
)

const rootUrl = new URL('./', import.meta.url)
const defaultSql = `SELECT
  n_regionkey,
  count(*) AS nations
FROM demo.analytics.nation
GROUP BY n_regionkey
ORDER BY n_regionkey;`

let activeRuntime = null
let metadataPromise = null

function loadMetadata() {
  metadataPromise ??= fetch(new URL('./data/demo.json', rootUrl), { cache: 'no-store' }).then(
    (response) => {
      if (!response.ok) throw new Error(`Demo metadata request failed: HTTP ${response.status}`)
      return response.json()
    },
  )
  return metadataPromise
}

function defaultCatalog(metadata, parquetUrl) {
  return {
    format_version: 1,
    schemas: [
      {
        name: 'analytics',
        tables: [
          {
            name: 'nation',
            snapshot: metadata.contentVersion,
            columns: metadata.columns,
            files: [{ uri: parquetUrl }],
          },
        ],
      },
    ],
  }
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const amount = value / 1024 ** exponent
  return `${amount >= 10 || exponent === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[exponent]}`
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function firstSchemaName(catalogSnapshot) {
  const name = catalogSnapshot?.schemas?.[0]?.name
  return typeof name === 'string' && name.length > 0 ? name : null
}

function catalogKey(catalogName, catalogSnapshot) {
  return `${catalogName}\n${JSON.stringify(catalogSnapshot)}`
}

function setStep(name, state, detail = '') {
  const element = steps.get(name)
  if (!element) return
  element.dataset.state = state
  const detailElement = element.querySelector('[data-step-detail]')
  if (detailElement) detailElement.textContent = detail || 'Waiting'
}

function resetRuntimeView() {
  setStep('source', 'idle', 'Waiting')
  setStep('catalog', 'idle', 'Waiting')
  setStep('query', 'idle', 'Waiting')
}

function resetResultView() {
  resultHead.innerHTML = ''
  resultBody.innerHTML = '<tr><td class="empty">Run SQL to see the result.</td></tr>'
  resultSummary.textContent = '—'
  logOutput.textContent = 'Diagnostics will appear here after the query.'
}

function populateFixtureInfo(metadata, parquetUrl) {
  fixtureUrlValue.href = parquetUrl
  fixtureUrlValue.textContent = parquetUrl
  fixtureRowsValue.textContent = Number(metadata.rows).toLocaleString()
  fixtureBytesValue.textContent = formatBytes(Number(metadata.bytes))
  fixtureColumnsValue.textContent = metadata.columns.map((column) => `${column.name} ${column.type}`).join(', ')
}

async function resetEditors({ announce = true } = {}) {
  const metadata = await loadMetadata()
  const parquetUrl = new URL('./data/demo.parquet', rootUrl).href
  catalogNameInput.value = 'demo'
  catalogEditor.value = `${JSON.stringify(defaultCatalog(metadata, parquetUrl), null, 2)}\n`
  sqlEditor.value = defaultSql
  if (announce) {
    statusText.textContent = 'Editors reset. Runtime is ready; Run SQL to apply the default catalog.'
  }
}

function parseCatalogEditor() {
  const catalogName = catalogNameInput.value.trim()
  if (!catalogName) throw new Error('Catalog name must not be empty.')

  let catalogSnapshot
  try {
    catalogSnapshot = JSON.parse(catalogEditor.value)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Catalog JSON is invalid: ${message}`)
  }

  return { catalogName, catalogSnapshot }
}

function parseSqlEditor() {
  const sql = sqlEditor.value.trim()
  if (!sql) throw new Error('SQL must not be empty.')
  return sql
}

function formatCell(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, (_key, item) =>
        typeof item === 'bigint' ? item.toString() : item,
      )
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function renderResult(result) {
  const fields = result.schema.fields.map((field) => field.name)
  const rows = result.toArray()

  resultHead.innerHTML = ''
  resultBody.innerHTML = ''

  if (fields.length > 0) {
    const headerRow = document.createElement('tr')
    for (const field of fields) {
      const th = document.createElement('th')
      th.textContent = field
      headerRow.append(th)
    }
    resultHead.append(headerRow)
  }

  if (rows.length === 0) {
    const tr = document.createElement('tr')
    const td = document.createElement('td')
    td.className = 'empty'
    td.colSpan = Math.max(fields.length, 1)
    td.textContent = 'Query returned no rows.'
    tr.append(td)
    resultBody.append(tr)
  } else {
    for (const row of rows) {
      const tr = document.createElement('tr')
      for (const field of fields) {
        const td = document.createElement('td')
        td.textContent = formatCell(row[field])
        tr.append(td)
      }
      resultBody.append(tr)
    }
  }

  resultSummary.textContent = `${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}`
}

async function probeParquet(parquetUrl) {
  const response = await fetch(parquetUrl, {
    cache: 'no-store',
    headers: { Range: 'bytes=0-0' },
  })
  const rangeSupported = response.status === 206
  const contentRange = response.headers.get('content-range')
  await response.body?.cancel()
  if (!response.ok) throw new Error(`Parquet source request failed: HTTP ${response.status}`)
  return {
    status: response.status,
    rangeSupported,
    contentRange,
  }
}

async function initializeCatalog(database, worker, catalogName, catalogSnapshot) {
  const catalog = await InMemoryCatalogController.initialize(
    database,
    worker,
    {
      workspaceId: `pages-demo-${crypto.randomUUID()}`,
      catalogName,
      extensionName: new URL(
        './extension/in_memory_catalog.duckdb_extension.wasm',
        rootUrl,
      ).href,
    },
    1n,
    catalogSnapshot,
  )

  const defaultSchema = firstSchemaName(catalogSnapshot)
  if (defaultSchema) {
    await catalog.connection.query(
      `USE ${quoteIdentifier(catalogName)}.${quoteIdentifier(defaultSchema)}`,
    )
  }

  return {
    catalog,
    catalogName,
    catalogSnapshot,
    catalogKey: catalogKey(catalogName, catalogSnapshot),
    defaultSchema,
  }
}

async function ensureCatalog(catalogName, catalogSnapshot) {
  if (!activeRuntime) throw new Error('DuckDB-Wasm runtime is not ready.')

  const nextKey = catalogKey(catalogName, catalogSnapshot)
  if (activeRuntime.catalogKey === nextKey) {
    setStep(
      'catalog',
      'done',
      activeRuntime.defaultSchema
        ? `Current schema: ${catalogName}.${activeRuntime.defaultSchema}`
        : `Read-only catalog attached as ${catalogName}`,
    )
    return
  }

  setStep('catalog', 'active', 'Applying edited catalog')
  await activeRuntime.catalog?.close()
  activeRuntime.catalog = null
  activeRuntime.catalogKey = null

  const nextCatalog = await initializeCatalog(
    activeRuntime.database,
    activeRuntime.worker,
    catalogName,
    catalogSnapshot,
  )
  Object.assign(activeRuntime, nextCatalog)
  setStep(
    'catalog',
    'done',
    nextCatalog.defaultSchema
      ? `Current schema: ${catalogName}.${nextCatalog.defaultSchema}`
      : `Read-only catalog attached as ${catalogName}`,
  )
}

async function cleanupRuntime() {
  const runtime = activeRuntime
  activeRuntime = null
  if (!runtime) return
  await runtime.catalog?.close().catch(() => {})
  await runtime.database?.terminate().catch(() => {})
  runtime.worker?.terminate()
}

async function startRuntime() {
  resetRuntimeView()
  resetResultView()
  statusText.textContent = 'Starting DuckDB-Wasm runtime…'

  let worker
  let database
  let catalog

  try {
    const metadata = await loadMetadata()
    const parquetUrl = new URL('./data/demo.parquet', rootUrl).href
    populateFixtureInfo(metadata, parquetUrl)
    await resetEditors({ announce: false })

    setStep('source', 'active', 'Checking the Pages-hosted Parquet file')
    const sourceProbe = await probeParquet(parquetUrl)
    setStep(
      'source',
      'done',
      sourceProbe.rangeSupported
        ? `Available with HTTP byte ranges (${formatBytes(Number(metadata.bytes))})`
        : `Available (HTTP ${sourceProbe.status}, ${formatBytes(Number(metadata.bytes))})`,
    )

    setStep('catalog', 'active', 'Starting DuckDB-Wasm and attaching the catalog')
    worker = new Worker(new URL('./in-memory-catalog/in-memory-catalog-worker.js', rootUrl))
    database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
    await database.instantiate(new URL('./duckdb/duckdb-eh.wasm', rootUrl).href)
    await database.open({
      allowUnsignedExtensions: true,
      maximumThreads: 1,
      query: { castBigIntToDouble: true },
      filesystem: {
        reliableHeadRequests: false,
        allowFullHTTPReads: true,
        forceFullHTTPReads: false,
      },
    })

    const { catalogName, catalogSnapshot } = parseCatalogEditor()
    const initializedCatalog = await initializeCatalog(
      database,
      worker,
      catalogName,
      catalogSnapshot,
    )
    catalog = initializedCatalog.catalog

    activeRuntime = {
      worker,
      database,
      ...initializedCatalog,
      metadata,
      parquetUrl,
      sourceProbe,
    }
    worker = database = catalog = null

    setStep(
      'catalog',
      'done',
      initializedCatalog.defaultSchema
        ? `Current schema: ${catalogName}.${initializedCatalog.defaultSchema}`
        : `Read-only catalog attached as ${catalogName}`,
    )
    setStep('query', 'idle', 'Ready')
    statusText.textContent = 'Runtime ready. Edit the catalog or SQL, then run the query.'
  } catch (error) {
    console.error(error)
    statusText.textContent = error instanceof Error ? error.message : String(error)
    const active = [...steps.values()].find((element) => element.dataset.state === 'active')
    if (active) active.dataset.state = 'error'
    logOutput.textContent = error instanceof Error ? error.stack || error.message : String(error)
    await catalog?.close().catch(() => {})
    await database?.terminate().catch(() => {})
    worker?.terminate()
    throw error
  }
}

async function runDemo() {
  if (!activeRuntime) return

  runButton.disabled = true
  resetButton.disabled = true
  runButton.textContent = 'Running…'
  resetResultView()

  try {
    const { catalogName, catalogSnapshot } = parseCatalogEditor()
    const sql = parseSqlEditor()

    statusText.textContent = 'Applying catalog and running SQL…'
    await ensureCatalog(catalogName, catalogSnapshot)

    setStep('query', 'active', 'Executing SQL in DuckDB-Wasm')
    const result = await activeRuntime.catalog.connection.query(sql)
    const catalogDiagnostics = await activeRuntime.catalog.diagnostics()

    renderResult(result)
    logOutput.textContent = JSON.stringify(
      {
        catalogName,
        defaultSchema: activeRuntime.defaultSchema,
        catalog: catalogSnapshot,
        sql,
        hostedFile: {
          url: activeRuntime.parquetUrl,
          rows: activeRuntime.metadata.rows,
          bytes: activeRuntime.metadata.bytes,
          rangeSupported: activeRuntime.sourceProbe.rangeSupported,
        },
        catalogDiagnostics,
      },
      null,
      2,
    )
    setStep('query', 'done', 'Query completed')
    statusText.textContent = 'Query completed entirely in your browser.'
  } catch (error) {
    console.error(error)
    statusText.textContent = error instanceof Error ? error.message : String(error)
    const active = [...steps.values()].find((element) => element.dataset.state === 'active')
    if (active) active.dataset.state = 'error'
    logOutput.textContent = error instanceof Error ? error.stack || error.message : String(error)
  } finally {
    runButton.disabled = false
    resetButton.disabled = false
    runButton.textContent = 'Run SQL'
  }
}

runButton.addEventListener('click', () => void runDemo())
resetButton.addEventListener('click', () => {
  void resetEditors().catch((error) => {
    statusText.textContent = error instanceof Error ? error.message : String(error)
  })
})
window.addEventListener('pagehide', () => void cleanupRuntime())

runButton.disabled = true
resetButton.disabled = true
void startRuntime()
  .then(() => {
    runButton.disabled = false
    resetButton.disabled = false
  })
  .catch(() => {
    runButton.disabled = true
    resetButton.disabled = false
  })
