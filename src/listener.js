/**
 * 网关自己的 HTTP 监听。
 *
 * ## 为什么不复用宿主的 webServer
 *
 * 挂在宿主 webServer 上的路由，其端口由 DSH 决定——用户换一次启动参数、或者
 * 端口被占用后宿主自己往后挪一位，base URL 就变了。而 base URL 是要填进别的
 * 应用（Codex、Claude Code、Cline……）配置里的东西，每变一次用户就得改一次。
 *
 * 所以这里**自己 listen 一个固定端口**，与宿主端口解耦。
 *
 * ## 端口被占用时不能把插件搞崩
 *
 * `EADDRINUSE` 只记进状态、写一条日志，**不向外抛**。原因是设置页还挂在宿主
 * webServer 上：插件若在 `apply` 阶段抛错，整个 fiber 失败，用户连"改个端口"
 * 的界面都打不开，只能去翻配置文件。让它带着错误状态活着，用户点两下就能改好。
 */

import { createServer } from 'node:http'

/** 端口号合法性：1–65535 的整数。 */
export function isValidPort(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

/**
 * 把 listen 的错误翻译成用户能照着做的一句话。
 *
 * @param error Node 抛出的错误
 * @param port 试图使用的端口
 */
export function describeListenError(error, port) {
  const code = error?.code
  if (code === 'EADDRINUSE') {
    return `端口 ${port} 已被其他程序占用。请在本页把端口改成另一个值（例如 ${port + 1}）后保存。`
  }
  if (code === 'EACCES') {
    return `没有权限监听端口 ${port}。请换一个大于 1024 的端口。`
  }
  if (code === 'EADDRNOTAVAIL') {
    return `本机没有可用的 127.0.0.1:${port}，请换一个端口。`
  }
  return `监听 ${port} 失败：${error instanceof Error ? error.message : String(error)}`
}

/**
 * 启动网关监听。
 *
 * @param options 配置
 * @param options.port 端口
 * @param options.handler `(req, res) => void`，与 webServer 的 handler 同形
 * @param options.logger 宿主 logger
 * @returns `{ state, ready, close }`
 *   - `state`：**活的对象**，`listening` / `error` 随事件更新，路由层直接读它
 *   - `ready`：等到出结果（成功或失败）才 resolve，不会 reject
 *   - `close`：关掉监听
 */
export function startListener({ port, handler, logger }) {
  const state = {
    port,
    listening: false,
    error: undefined,
  }

  const server = createServer((req, res) => {
    /*
     * handler 内部已经是「任何失败都变成响应」的写法，这里再兜一层：同步抛出的
     * 异常若逃到 http 模块，Node 会直接销毁 socket，客户端看到的是空响应，
     * 排查时毫无线索。
     */
    try {
      const result = handler(req, res)
      if (result !== undefined && typeof result.catch === 'function') {
        result.catch((error) => fail(res, error, logger))
      }
    } catch (error) {
      fail(res, error, logger)
    }
  })

  const ready = new Promise((resolve) => {
    /* 只处理第一次 listen 的结果；后续运行期错误走下面的 error 监听。 */
    server.once('error', (error) => {
      state.listening = false
      state.error = describeListenError(error, port)
      logger?.warn?.(`workbuddy-gateway: ${state.error}`)
      resolve(state)
    })
    server.listen(port, '127.0.0.1', () => {
      state.listening = true
      state.error = undefined
      logger?.info?.(`workbuddy-gateway: gateway listening on http://127.0.0.1:${port}`)
      resolve(state)
    })
  })

  /* 运行期再出错（例如被系统回收）时保持状态诚实。 */
  server.on('error', (error) => {
    state.listening = false
    state.error = describeListenError(error, state.port)
  })

  return {
    state,
    ready,
    close: () => new Promise((resolve) => {
      if (server.listening !== true) {
        resolve()
        return
      }
      server.close(() => resolve())
      /* 已建立的 keep-alive 连接会拖住 close；给它们一个上限。 */
      setTimeout(() => resolve(), 1000).unref?.()
    }),
  }
}

/** 兜底错误响应（此时可能已经发过头，所以要判 headersSent）。 */
function fail(res, error, logger) {
  logger?.warn?.(`workbuddy-gateway: request failed: ${error instanceof Error ? error.message : String(error)}`)
  if (res.headersSent === true) {
    res.end()
    return
  }
  try {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { message: 'internal gateway error', type: 'api_error' } }))
  } catch {
    /* 连接已经没了，无从回应。 */
  }
}
