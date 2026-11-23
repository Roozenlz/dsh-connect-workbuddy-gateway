/** HTTP / SSE / JSON 小工具。供网关各协议共用。 */

/** 读一个请求体，超过 limit 直接拒绝。 */
export function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error(`request body exceeds ${limit} bytes`)
        error.status = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 读一个 JSON 请求体。空体返回 undefined。 */
export async function readJson(req, limit) {
  const text = await readBody(req, limit)
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('request body is not valid JSON')
    error.status = 400
    throw error
  }
}

export function sendJson(res, status, body, headers) {
  if (res.headersSent) {
    res.end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...(headers ?? {}),
  })
  res.end(text)
}

/** 打开一条 SSE 响应；返回写入器。 */
export function openSse(res, headers) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(headers ?? {}),
  })
  res.flushHeaders?.()
  let closed = false
  res.on('close', () => { closed = true })
  return {
    get closed() { return closed || !res.writable },
    raw(line) {
      if (closed || !res.writable) return
      res.write(line)
    },
    /** 一条 `event: <name>` + `data: <json>` 的 SSE 帧。 */
    event(name, payload) {
      if (closed || !res.writable) return
      const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
      res.write(name === undefined ? `data: ${data}\n\n` : `event: ${name}\ndata: ${data}\n\n`)
    },
    data(payload) {
      this.event(undefined, payload)
    },
    end() {
      if (closed || !res.writable) return
      res.end()
    },
  }
}

export function randomId(prefix = '') {
  const tail = globalThis.crypto.randomUUID().replaceAll('-', '')
  return prefix === '' ? tail : `${prefix}${tail.slice(0, 24)}`
}

export function nowSec() {
  return Math.floor(Date.now() / 1000)
}

/** 把错误转成网关统一错误体的形状。 */
export function failureOf(error) {
  const status = typeof error?.status === 'number' ? error.status : 500
  const code = typeof error?.code === 'string' ? error.code : status === 400 ? 'invalid_request_error' : 'internal_error'
  return { status, code, message: error instanceof Error ? error.message : String(error) }
}

/** 采样一个工具调用 id，保证同一请求内唯一。 */
export function idFactory(prefix) {
  let n = 0
  return () => `${prefix}_${(n += 1)}`
}
