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
const rowsValue = document.querySelector('#metric-rows')
const bytesValue = document.querySelector('#metric-bytes')
const transportValue = document.querySelector('#metric-transport')
const parquetUriValue = document.querySelector('#parquet-uri')
const logOutput = document.querySelector('#diagnostics')
const steps = new Map(
  [...document.querySelectorAll('[data-step]')].map((element) => [element.dataset.step, element]),
)

const rootUrl = new URL('./', import.meta.url)
const defaultStatus =
  'The default table points to a Parquet file published by this GitHub Pages site and is read directly over HTTPS.'
const defaultSql = `SELECT
  category,
  count(*) AS rows,
  round(avg(metric), 2) AS avg_metric
FROM demo.analytics.events
GROUP BY category
ORDER BY category;`

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

function defaultCatalog(metadata) {
  return {
    format_version: 1,
    schemas: [
      {
        name: 'analytics',
        tables: [
          {
            name: 'events',
            snapshot: '$DEMO_CONTENT_VERSION',
            columns: metadata.columns,
            files: [{ uri: '$DEMO_FILE' }],
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

function setStep(name, state, detail = '') {
  const element = steps.get(name)
  if (!element) return
  element.dataset.state = state
  const detailElement = element.querySelector('[data-step-detail]')
  if (detailElement && detail) detailElement.textContent = detail
}

function resetView() {
  for (const element of steps.values()) {
    element.dataset.state = 'idle'
    const detailElement = element.querySelector('[data-step-detail]')
    if (detailElement) detailElement.textContent = 'Waiting'
  }
  resultHead.innerHTML = ''
  resultBody.innerHTML = '<tr><td class="empty">Run SQL to see the result.</td></tr>'
  resultSummary.textContent = '—'
  rowsValue.textContent = '—'
  bytesValue.textContent = '—'
  transportValue.textContent = 'HTTPS'
  parquetUriValue.textContent = '—'
  logOutput.textContent = 'Diagnostics will appear here after the query.'
}

async function resetEditors() {
  const metadata = await loadMetadata()
  catalogNameInput.value = 'demo'
  catalogEditor.value = `${JSON.stringify(defaultCatalog(metadata), null, 2)}\n`
  sqlEditor.value = defaultSql
  statusText.textContent = defaultStatus
}

async function cleanupRuntime() {
  const runtime = activeRuntime
  activeRuntime = null
  if (!runtime) return
  await runtime.catalog?.close().catch(() => {})
  await runtime.database?.terminate().catch(() => {})
  runtime.worker?.terminate()
}

function resolveDemoPlaceholders(value, replacements) {
  if (value === '$DEMO_FILE') return replacements.demoFile
  if (value === '$DEMO_CONTENT_VERSION') return replacements.contentVersion
  if (Array.isArray(value)) {
    return value.map((item) => resolveDemoPlaceholders(item, replacements))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveDemoPlaceholders(item, replacements),
      ]),
    )
  }
  return value
}

function parseEditors(parquetUrl, metadata) {
  const catalogName = catalogNameInput.value.trim()
  if (!catalogName) throw new Error('Catalog name must not be empty.')

  const sql = sqlEditor.value.trim()
  if (!sql) throw new Error('SQL must not be empty.')

  let parsedCatalog
  try {
    parsedCatalog = JSON.parse(catalogEditor.value)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Catalog JSON is invalid: ${message}`)
  }

  return {
    catalogName,
    sql,
    catalogSnapshot: resolveDemoPlaceholders(parsedCatalog, {
      demoFile: parquetUrl,
      contentVersion: metadata.contentVersion,
    }),
  }
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
    transport: rangeSupported ? 'HTTPS Range' : 'HTTPS',
  }
}

async function runDemo() {
  runButton.disabled = true
  resetButton.disabled = true
  runButton.textContent = 'Running…'
  statusText.textContent = 'Starting browser runtime…'
  resetView()
  await cleanupRuntime()

  let worker
  let database
  let catalog

  try {
    const metadata = await loadMetadata()
    const parquetUrl = new URL('./data/demo.parquet', rootUrl).href
    parquetUriValue.textContent = parquetUrl
    rowsValue.textContent = Number(metadata.rows).toLocaleString()
    bytesValue.textContent = formatBytes(Number(metadata.bytes))

    setStep('source', 'active', 'Probing the Pages-hosted Parquet URL')
    const sourceProbe = await probeParquet(parquetUrl)
    transportValue.textContent = sourceProbe.transport
    setStep(
      'source',
      'done',
      sourceProbe.rangeSupported
        ? `HTTP 206 byte ranges available (${formatBytes(Number(metadata.bytes))})`
        : `HTTP ${sourceProbe.status}; full HTTPS reads are allowed`,
    )

    const { catalogName, sql, catalogSnapshot } = parseEditors(parquetUrl, metadata)

    setStep('catalog', 'active', 'Starting DuckDB-Wasm Dedicated Worker')
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

    catalog = await InMemoryCatalogController.initialize(
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
      setStep('catalog', 'done', `Current schema: ${catalogName}.${defaultSchema}`)
    } else {
      setStep('catalog', 'done', `Read-only catalog attached as ${catalogName}`)
    }

    setStep('query', 'active', 'DuckDB is reading the Parquet URI directly over HTTPS')
    const result = await catalog.connection.query(sql)
    const catalogDiagnostics = await catalog.diagnostics()

    renderResult(result)
    logOutput.textContent = JSON.stringify(
      {
        catalogName,
        defaultSchema,
        catalog: catalogSnapshot,
        sql,
        parquetUrl,
        sourceProbe,
        sourceBytes: metadata.bytes,
        catalogDiagnostics,
        serviceWorker: 'not used',
      },
      null,
      2,
    )
    setStep('query', 'done', 'Query completed from the direct HTTPS file URI')
    statusText.textContent = 'Query completed entirely in your browser using the Pages-hosted Parquet file.'

    activeRuntime = { worker, database, catalog }
    worker = database = catalog = null
  } catch (error) {
    console.error(error)
    statusText.textContent = error instanceof Error ? error.message : String(error)
    const active = [...steps.values()].find((element) => element.dataset.state === 'active')
    if (active) active.dataset.state = 'error'
    logOutput.textContent = error instanceof Error ? error.stack || error.message : String(error)
  } finally {
    await catalog?.close().catch(() => {})
    await database?.terminate().catch(() => {})
    worker?.terminate()
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
resetView()
void resetEditors()
  .then(() => {
    runButton.disabled = false
    resetButton.disabled = false
  })
  .catch((error) => {
    console.error(error)
    statusText.textContent = error instanceof Error ? error.message : String(error)
  })
