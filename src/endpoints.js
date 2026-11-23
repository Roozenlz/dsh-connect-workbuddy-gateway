/**
 * 各协议对外暴露的准确地址。
 *
 * 客户端填的「API 地址 / Base URL」各不相同，而且它们**自己还会往后拼路径**：
 * OpenAI SDK 拼 `/chat/completions`，Anthropic SDK 拼 `/v1/messages`，Gemini
 * SDK 拼 `/v1beta/models/...`。让用户自己算这道题是这类网关最常见的失败点（拼错
 * 就得到 404，而 404 看起来像"服务根本没起来"）。
 *
 * 所以这里对每种协议给出两个东西：
 *
 *   `baseUrl`     —— 填进客户端「API Base / Base URL」那一栏的成品
 *   `requestUrl`  —— SDK 拼完之后真正会打到的那条地址，供页面上核对
 *
 * 并且这两条地址**都真的被路由接受**：`/v1` 与 `/anthropic` 只是可选前缀，
 * 语义与根路径完全一致。于是「复制 → 粘贴 → 能跑」，不需要任何补丁式修改。
 */

const PREFIX = '/workbuddy-gateway'

/**
 * 协议清单。
 *
 * `baseSuffix` 是按各家 SDK 的拼接习惯算的：SDK 会自己补的部分不能出现在
 * baseUrl 里，否则就拼成 `/v1/v1/messages`。
 */
export const PROTOCOLS = [
  {
    id: 'openai-chat',
    name: 'OpenAI Chat Completions',
    /** OpenAI SDK 会自己拼 `/chat/completions`，所以 base 到 `/v1` 为止。 */
    baseSuffix: '/v1',
    endpoint: '/v1/chat/completions',
    authHint: 'Authorization: Bearer <key>',
    hint: 'OpenAI SDK、以及所有标着 “OpenAI compatible” 的客户端',
  },
  {
    id: 'openai-responses',
    name: 'OpenAI Responses',
    baseSuffix: '/v1',
    endpoint: '/v1/responses',
    authHint: 'Authorization: Bearer <key>',
    hint: 'OpenAI 新版 Responses API',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Messages',
    /** Anthropic SDK 会自己拼 `/v1/messages`，所以 base 就是根。 */
    baseSuffix: '',
    endpoint: '/v1/messages',
    authHint: 'x-api-key: <key> + anthropic-version',
    hint: 'Claude SDK / Anthropic 兼容客户端',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    /** Gemini SDK 会自己拼 `/v1beta/models/<model>:generateContent`。 */
    baseSuffix: '',
    endpoint: '/v1beta/models/{model}:generateContent',
    authHint: 'x-goog-api-key: <key>',
    hint: 'Google GenAI SDK',
  },
]

/**
 * 算出一份对外的 base 与四条准确地址。
 * @param origin 例如 `http://127.0.0.1:9055`
 */
export function describeEndpoints(origin) {
  const root = `${origin}${PREFIX}`
  const endpoints = PROTOCOLS.map((protocol) => ({
    id: protocol.id,
    name: protocol.name,
    hint: protocol.hint,
    authHint: protocol.authHint,
    /* 填进客户端的那一栏。 */
    baseUrl: `${root}${protocol.baseSuffix}`,
    /* SDK 拼完之后真的会打到的地址。 */
    requestUrl: `${root}${protocol.endpoint}`,
    /* 有的客户端把 base 当完整地址用，给了这条就不用猜。 */
    fullUrl: `${root}${protocol.endpoint}`,
  }))
  return {
    root,
    endpoints,
    byId: Object.fromEntries(endpoints.map((entry) => [entry.id, entry])),
  }
}

/**
 * 去掉可选的协议前缀，把路径归一到路由表那一层。
 *
 * `/v1`、`/anthropic`、`/openai` 三个前缀都只是「让客户端填就对了」的便利写法，
 * 不携带语义差异。有的客户端会把它们叠起来（把 base 填成 `…/anthropic` 之后，
 * Anthropic SDK 又补一个 `/v1/messages`），所以这里是**循环剥离**，不是剥一层。
 * 归一之后下面只需要一套路由表。
 */
export function stripApiPrefix(path) {
  let out = path
  for (;;) {
    const before = out
    for (const prefix of ['/v1', '/anthropic', '/openai', '/gemini']) {
      if (out === prefix) return '/'
      if (out.startsWith(`${prefix}/`)) {
        out = out.slice(prefix.length)
        break
      }
    }
    if (out === before) break
  }
  return out === '' ? '/' : out
}
