import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'

const root = resolve('build/pages')
const port = Number(process.env.PORT || 4175)

function contentType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.wasm': return 'application/wasm'
    case '.parquet': return 'application/vnd.apache.parquet'
    default: return 'application/octet-stream'
  }
}

function parseRange(value, size) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(value)
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] === '' ? size - 1 : Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  if (start < 0 || start >= size || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end()
      return
    }

    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    let relativePath = decodeURIComponent(url.pathname.slice(1))
    if (relativePath === '' || relativePath.endsWith('/')) relativePath += 'index.html'
    const normalizedPath = normalize(relativePath)
    if (normalizedPath === '..' || normalizedPath.startsWith('../')) {
      response.writeHead(404).end()
      return
    }

    const bytes = await readFile(join(root, normalizedPath))
    const rangeHeader = request.headers.range
    const range = rangeHeader ? parseRange(rangeHeader, bytes.byteLength) : null
    if (rangeHeader && !range) {
      response.setHeader('Content-Range', `bytes */${bytes.byteLength}`)
      response.writeHead(416).end()
      return
    }

    const start = range?.start ?? 0
    const end = range?.end ?? bytes.byteLength - 1
    const body = bytes.subarray(start, end + 1)
    const status = range ? 206 : 200

    response.setHeader('Accept-Ranges', 'bytes')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', contentType(normalizedPath))
    response.setHeader('Content-Length', body.byteLength)
    if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.byteLength}`)

    if (request.method === 'HEAD') {
      response.writeHead(status).end()
      return
    }
    response.writeHead(status).end(body)
  } catch {
    response.writeHead(404).end()
  }
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Pages demo listening at http://127.0.0.1:${port}/\n`)
})
