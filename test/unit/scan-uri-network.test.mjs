import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'

describe('DuckDB scan URI HTTP behavior', () => {
  it('does not send the internal fragment to the HTTP endpoint', async () => {
    const requests = []
    const server = createServer((request, response) => {
      requests.push(request.url)
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end('ok')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')

    try {
      const address = server.address()
      const scanUri = `http://127.0.0.1:${address.port}/events?part=1#duckdb-snapshot=events-r42`
      const response = await fetch(scanUri)
      await response.arrayBuffer()

      assert.equal(response.status, 200)
      assert.deepEqual(requests, ['/events?part=1'])
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})
