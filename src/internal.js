/**
 * 各协议共用的内部请求模型。
 *
 * 四种协议的请求体形状完全不同，但语义只有一种：一段可带图片与工具调用的对话。
 * 每个协议文件先把入站请求规整成这里定义的 {@link InternalRequest}，再由
 * {@link toGenerateOptions} 唯一一次投影成宿主的 `GenerateOptions` —— 于是
 * 「怎么翻译成上游」只有一处实现，四种协议的差别只留在各自的序列化上。
 */

/** 一段对话内容块。 */
export const BlockKind = {
  text: 'text',
  image: 'image',
  toolCall: 'tool-call',
  toolResult: 'tool-result',
}

export function textBlock(text) {
  return { type: 'text', text }
}

export function imageBlock({ mediaType, data }) {
  return { type: 'image', mediaType, data }
}

/**
 * 创建一个空的内部请求。
 * @param overrides 覆盖默认字段。
 */
export function internalRequest(overrides) {
  return {
    model: '',
    system: undefined,
    messages: [],
    tools: undefined,
    toolChoice: undefined,
    temperature: undefined,
    topP: undefined,
    maxTokens: undefined,
    stop: undefined,
    reasoningEffort: undefined,
    stream: false,
    ...overrides,
  }
}

/** 把 config 里的 `stop` 规整成字符串数组。 */
export function normalizeStop(stop) {
  if (stop === undefined || stop === null) return undefined
  const list = Array.isArray(stop) ? stop : [stop]
  const kept = list.filter((entry) => typeof entry === 'string' && entry !== '')
  return kept.length === 0 ? undefined : kept
}
