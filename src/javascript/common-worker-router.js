(function initializeCommonWorkerRouter(global) {
  'use strict'

  const NAMESPACE_PATTERN = /^[A-Z][A-Z0-9_]*$/

  function createWorkerRouter(dispatchDuckDBMessage, workerGlobal = global) {
    if (typeof dispatchDuckDBMessage !== 'function') {
      throw new TypeError('DuckDB message dispatcher must be a function')
    }

    const handlers = new Map()

    function registerNamespace(namespace, handler) {
      if (typeof namespace !== 'string' || !NAMESPACE_PATTERN.test(namespace)) {
        throw new TypeError('Worker message namespace must use uppercase letters, digits, and underscores')
      }
      if (typeof handler !== 'function') {
        throw new TypeError('Worker message handler must be a function')
      }
      for (const registered of handlers.keys()) {
        if (overlaps(namespace, registered)) {
          throw new Error(`Worker message namespace ${namespace} overlaps registered namespace ${registered}`)
        }
      }
      handlers.set(namespace, handler)
    }

    async function handleMessage(event) {
      const messageType = event?.data?.type
      if (typeof messageType === 'string') {
        for (const [namespace, handler] of handlers) {
          if (messageType.startsWith(`${namespace}_`)) {
            return handler(event)
          }
        }
      }
      return dispatchDuckDBMessage.call(workerGlobal, event)
    }

    return Object.freeze({ registerNamespace, handleMessage })
  }

  function overlaps(left, right) {
    return left === right || left.startsWith(`${right}_`) || right.startsWith(`${left}_`)
  }

  global.DuckDBCommonWorkerRouter = Object.freeze({ createWorkerRouter })
})(globalThis)
