const MAX_UINT64 = (1n << 64n) - 1n

export class InMemoryCatalogControllerError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'InMemoryCatalogControllerError'
    this.code = code
  }
}

export class InMemoryCatalogController {
  #connection
  #session
  #workspaceId
  #catalogName
  #onRecoveryRequired
  #pending = Promise.resolve()
  #closePromise
  #attached = false
  #currentRevision
  #state = 'active'
  #recoveryReported = false

  static async initialize(db, worker, options, initialRevision, initialSnapshot) {
    const normalized = normalizeOptions(options)
    const connection = await db.connect()
    let controller
    try {
      await connection.query('LOAD parquet')
      await connection.query(`LOAD ${quote(normalized.extensionName)}`)
      const session = await WorkspaceSessionClient.open(
        worker,
        normalized.workspaceId,
        normalized.ackTimeoutMs,
      )
      controller = new InMemoryCatalogController(connection, session, normalized)
      await controller.publishSnapshot(initialRevision, initialSnapshot)
      await connection.query(
        `ATTACH ${quote(normalized.workspaceId)} AS ${quoteIdentifier(normalized.catalogName)} ` +
        '(TYPE in_memory_catalog, READ_ONLY)',
      )
      controller.#attached = true
      return controller
    } catch (error) {
      if (controller) {
        try {
          await controller.close()
        } catch {
          // Recovery notification is emitted by close; preserve the initialization error.
        }
      } else {
        await connection.close()
      }
      throw error
    }
  }

  constructor(connection, session, options) {
    this.#connection = connection
    this.#session = session
    this.#workspaceId = options.workspaceId
    this.#catalogName = options.catalogName
    this.#onRecoveryRequired = options.onRecoveryRequired
  }

  get connection() {
    return this.#connection
  }

  get currentRevision() {
    return this.#currentRevision
  }

  get state() {
    return this.#state
  }

  publishSnapshot(revision, snapshot) {
    if (this.#state !== 'active') {
      return Promise.reject(new InMemoryCatalogControllerError(
        'RC_CATALOG_WORKSPACE_CLOSED',
        'In-Memory Catalog workspace controller is closed',
      ))
    }
    const normalizedRevision = normalizeRevision(revision)
    const operation = this.#pending.then(async () => {
      const result = await this.#session.request(
        'IN_MEMORY_CATALOG_REPLACE_SNAPSHOT',
        'IN_MEMORY_CATALOG_REPLACE_SNAPSHOT_RESULT',
        { catalog_revision: normalizedRevision, snapshot },
      )
      requireSuccessfulResult(result, 'Catalog publication failed')
      if (result.revision !== normalizedRevision.toString()) {
        throw new InMemoryCatalogControllerError(
          'RC_REMOTE_IO',
          'Catalog publication returned an unexpected revision',
        )
      }
      this.#currentRevision = normalizedRevision
    })
    this.#pending = operation.catch(() => {})
    return operation
  }

  diagnostics() {
    if (this.#state !== 'active') {
      return Promise.reject(new InMemoryCatalogControllerError(
        'RC_CATALOG_WORKSPACE_CLOSED',
        'In-Memory Catalog workspace controller is closed',
      ))
    }
    return this.#pending.then(async () => {
      const result = await this.#session.request(
        'IN_MEMORY_CATALOG_GET_DIAGNOSTICS',
        'IN_MEMORY_CATALOG_GET_DIAGNOSTICS_RESULT',
      )
      requireSuccessfulResult(result, 'Catalog diagnostics failed')
      return result.diagnostics
    })
  }

  close() {
    if (this.#closePromise) return this.#closePromise
    this.#state = 'closing'
    this.#closePromise = this.#performClose()
    return this.#closePromise
  }

  async #performClose() {
    await this.#pending
    let failure
    try {
      if (this.#attached) {
        await this.#connection.query(`DETACH ${quoteIdentifier(this.#catalogName)}`)
        this.#attached = false
      }
      const result = await this.#session.request(
        'IN_MEMORY_CATALOG_DROP_WORKSPACE',
        'IN_MEMORY_CATALOG_DROP_WORKSPACE_RESULT',
      )
      requireSuccessfulResult(result, 'Catalog workspace drop failed')
      this.#state = 'closed'
    } catch (error) {
      this.#state = 'failed_closed'
      this.#reportRecoveryRequired()
      failure = new InMemoryCatalogControllerError(
        'RC_CATALOG_RECOVERY_REQUIRED',
        error instanceof Error ? error.message : 'Catalog workspace close result is unknown',
      )
    } finally {
      this.#session.close()
      try {
        await this.#connection.close()
      } catch (error) {
        if (!failure) {
          this.#state = 'failed_closed'
          this.#reportRecoveryRequired()
          failure = new InMemoryCatalogControllerError(
            'RC_CATALOG_RECOVERY_REQUIRED',
            error instanceof Error ? error.message : 'Catalog connection close failed',
          )
        }
      }
    }
    if (failure) throw failure
  }

  #reportRecoveryRequired() {
    if (this.#recoveryReported) return
    this.#recoveryReported = true
    try {
      this.#onRecoveryRequired?.({
        component: 'in_memory_catalog',
        workspaceId: this.#workspaceId,
      })
    } catch {
      // Recovery is already required; observer failures must not replace that result.
    }
  }
}

class WorkspaceSessionClient {
  #port
  #ackTimeoutMs
  #sequence = 0
  #waiter
  #closed = false

  static async open(worker, workspaceId, ackTimeoutMs) {
    const channel = new MessageChannel()
    const client = new WorkspaceSessionClient(channel.port1, ackTimeoutMs)
    const opened = client.#waitFor(
      'IN_MEMORY_CATALOG_WORKSPACE_SESSION_OPENED',
      undefined,
    )
    try {
      worker.postMessage({
        type: 'IN_MEMORY_CATALOG_OPEN_WORKSPACE_SESSION',
        workspace_id: workspaceId,
      }, [channel.port2])
    } catch (error) {
      client.close()
      try {
        await opened
      } catch {
        // Consume the waiter rejection caused by closing the local port.
      }
      throw new InMemoryCatalogControllerError(
        'RC_REMOTE_IO',
        error instanceof Error ? error.message : 'Could not open Catalog workspace session',
      )
    }
    try {
      const result = await opened
      requireSuccessfulResult(result, 'Could not open Catalog workspace session')
      return client
    } catch (error) {
      client.close()
      throw error
    }
  }

  constructor(port, ackTimeoutMs) {
    this.#port = port
    this.#ackTimeoutMs = ackTimeoutMs
    port.onmessage = (event) => this.#receive(event.data)
    port.onmessageerror = () => this.#rejectWaiter(new InMemoryCatalogControllerError(
      'RC_REMOTE_IO',
      'Catalog workspace reply was invalid',
    ))
    port.start?.()
  }

  request(type, resultType, payload = {}) {
    if (this.#closed) {
      return Promise.reject(new InMemoryCatalogControllerError(
        'RC_CATALOG_WORKSPACE_CLOSED',
        'Catalog workspace session is closed',
      ))
    }
    if (this.#waiter) {
      return Promise.reject(new InMemoryCatalogControllerError(
        'RC_REMOTE_IO',
        'Catalog workspace already has an operation in flight',
      ))
    }
    const requestId = `catalog-${++this.#sequence}`
    const result = this.#waitFor(resultType, requestId)
    this.#port.postMessage({ type, request_id: requestId, ...payload })
    return result
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.#rejectWaiter(new InMemoryCatalogControllerError(
      'RC_REMOTE_IO',
      'Catalog workspace session closed before receiving a reply',
    ))
    this.#port.close()
  }

  #waitFor(type, requestId) {
    if (this.#waiter) {
      return Promise.reject(new InMemoryCatalogControllerError(
        'RC_REMOTE_IO',
        'Catalog workspace already has an operation in flight',
      ))
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#waiter?.reject !== reject) return
        this.#waiter = undefined
        reject(new InMemoryCatalogControllerError(
          'RC_REMOTE_IO',
          'Catalog workspace acknowledgement timed out',
        ))
      }, this.#ackTimeoutMs)
      this.#waiter = { type, requestId, resolve, reject, timeout }
    })
  }

  #receive(message) {
    const waiter = this.#waiter
    if (!waiter || message?.type !== waiter.type) return
    if (waiter.requestId !== undefined && message?.request_id !== waiter.requestId) return
    this.#waiter = undefined
    clearTimeout(waiter.timeout)
    waiter.resolve(message)
  }

  #rejectWaiter(error) {
    const waiter = this.#waiter
    if (!waiter) return
    this.#waiter = undefined
    clearTimeout(waiter.timeout)
    waiter.reject(error)
  }
}

function normalizeOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new InMemoryCatalogControllerError('RC_METADATA_INVALID', 'Controller options are required')
  }
  if (options.onRecoveryRequired !== undefined && typeof options.onRecoveryRequired !== 'function') {
    throw new InMemoryCatalogControllerError(
      'RC_METADATA_INVALID',
      'onRecoveryRequired must be a function',
    )
  }
  const ackTimeoutMs = options.ackTimeoutMs === undefined ? 5_000 : options.ackTimeoutMs
  if (!Number.isSafeInteger(ackTimeoutMs) || ackTimeoutMs <= 0) {
    throw new InMemoryCatalogControllerError(
      'RC_METADATA_INVALID',
      'ackTimeoutMs must be a positive safe integer',
    )
  }
  return {
    workspaceId: requireName(options.workspaceId, 'workspaceId'),
    catalogName: requireName(options.catalogName, 'catalogName'),
    extensionName: options.extensionName === undefined
      ? 'in_memory_catalog'
      : requireName(options.extensionName, 'extensionName'),
    ackTimeoutMs,
    onRecoveryRequired: options.onRecoveryRequired,
  }
}

function normalizeRevision(value) {
  if (typeof value === 'bigint' && value >= 0n && value <= MAX_UINT64) return value
  throw new InMemoryCatalogControllerError(
    'RC_METADATA_INVALID',
    'Catalog revision must be a bigint in uint64 range',
  )
}

function requireSuccessfulResult(result, fallbackMessage) {
  if (result?.ok === true) return
  throw new InMemoryCatalogControllerError(
    typeof result?.code === 'string' ? result.code : 'RC_REMOTE_IO',
    typeof result?.message === 'string' ? result.message : fallbackMessage,
  )
}

function requireName(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new InMemoryCatalogControllerError(
      'RC_METADATA_INVALID',
      `${field} must be a non-empty string without NUL`,
    )
  }
  return value
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`
}
