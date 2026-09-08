import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

await import('../../src/javascript/common-worker-router.js')

const { createWorkerRouter } = globalThis.DuckDBCommonWorkerRouter

describe('Common Worker Router', () => {
  it('routes one namespaced message without delegating to DuckDB', async () => {
    const handled = []
    const router = createWorkerRouter(() => assert.fail('unexpected DuckDB delegation'))
    router.registerNamespace('IN_MEMORY_CATALOG', async (event) => handled.push(event.data))

    await router.handleMessage({ data: { type: 'IN_MEMORY_CATALOG_OPEN_WORKSPACE_SESSION' } })

    assert.deepEqual(handled, [{ type: 'IN_MEMORY_CATALOG_OPEN_WORKSPACE_SESSION' }])
  })

  it('delegates unknown messages with the original worker context', async () => {
    const delegated = []
    const workerGlobal = { name: 'duckdb-worker' }
    const event = { data: { type: 'DUCKDB_PING' } }
    const router = createWorkerRouter(
      function dispatchDuckDBMessage(value) { delegated.push({ context: this, value }) },
      workerGlobal,
    )

    await router.handleMessage(event)

    assert.deepEqual(delegated, [{ context: workerGlobal, value: event }])
  })

  it('does not fall through when a component handler fails', async () => {
    let delegated = false
    const router = createWorkerRouter(() => { delegated = true })
    router.registerNamespace('CACHED_FS', async () => { throw new Error('component failure') })

    await assert.rejects(
      router.handleMessage({ data: { type: 'CACHED_FS_OPEN_REGISTRY_SESSION' } }),
      /component failure/,
    )
    assert.equal(delegated, false)
  })

  it('rejects duplicate and overlapping namespaces', () => {
    const router = createWorkerRouter(() => {})
    router.registerNamespace('IN_MEMORY_CATALOG', () => {})

    assert.throws(
      () => router.registerNamespace('IN_MEMORY_CATALOG', () => {}),
      /overlaps registered namespace/,
    )
    assert.throws(
      () => router.registerNamespace('IN_MEMORY', () => {}),
      /overlaps registered namespace/,
    )
  })

  it('routes independently of component registration order', async () => {
    for (const namespaces of [
      ['IN_MEMORY_CATALOG', 'CACHED_FS'],
      ['CACHED_FS', 'IN_MEMORY_CATALOG'],
    ]) {
      const handled = []
      const router = createWorkerRouter(() => assert.fail('unexpected DuckDB delegation'))
      for (const namespace of namespaces) {
        router.registerNamespace(namespace, () => handled.push(namespace))
      }

      await router.handleMessage({ data: { type: 'CACHED_FS_OPEN_REGISTRY_SESSION' } })
      assert.deepEqual(handled, ['CACHED_FS'])
    }
  })
})
