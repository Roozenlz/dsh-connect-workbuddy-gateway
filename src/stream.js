/** 统一增量流：宿主的 StreamChunk 与上游 SSE 都翻译成这一套事件。 */

/**
 * 规范化事件：
 *   {type:'text', text}
 *   {type:'reasoning', text}
 *   {type:'tool-call', id, name?, argumentsDelta}
 *   {type:'usage', usage}
 *   {type:'finish', reason}
 */

/** 宿主 StreamChunk 流 → 规范化事件流。 */
export async function* fromHostChunks(chunks) {
  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        if (chunk.text !== '') yield { type: 'text', text: chunk.text }
        break
      case 'reasoning-delta':
        if (chunk.text !== '') yield { type: 'reasoning', text: chunk.text }
        break
      case 'tool-call-delta':
        yield { type: 'tool-call', id: chunk.id, name: chunk.name, argumentsDelta: chunk.argumentsDelta ?? '' }
        break
      case 'usage':
        yield { type: 'usage', usage: chunk.usage }
        break
      case 'finish':
        yield { type: 'finish', reason: chunk.reason }
        break
      default:
        break
    }
  }
}

/**
 * OpenAI Chat Completions 的 SSE 流 → 规范化事件流。
 *
 * `reasoning_content` 是 WorkBuddy 上游的思考字段（pi-ai 也按这个名字记录），
 * 与正文一样按 delta 转发。
 */
export async function* fromOpenAiSse(body, signal) {
  if (body === null) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let carry = ''
  try {
    for (;;) {
      if (signal?.aborted === true) return
      const { done, value } = await reader.read()
      if (done) break
      carry += decoder.decode(value, { stream: true })
      let start = 0
      for (;;) {
        const newline = carry.indexOf('\n', start)
        if (newline === -1) break
        const line = carry.slice(start, newline).trimEnd()
        start = newline + 1
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') {
          if (payload === '[DONE]') {
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
          continue
        }
        let parsed
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }
        yield* fromOpenAiChunk(parsed)
      }
      carry = carry.slice(start)
    }
    const tail = carry.trim()
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim()
      if (payload !== '' && payload !== '[DONE]') {
        try {
          yield* fromOpenAiChunk(JSON.parse(payload))
        } catch {
          /* 尾部半帧：丢弃 */
        }
      }
    }
  } finally {
    reader.releaseLock?.()
  }
}

/** 一个 OpenAI chunk → 规范化事件。 */
export function* fromOpenAiChunk(chunk) {
  if (chunk?.usage !== undefined && chunk.usage !== null) {
    yield { type: 'usage', usage: mapOpenAiUsage(chunk.usage) }
  }
  const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined
  if (choice === undefined || choice === null) return
  const delta = choice.delta ?? {}
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
    yield { type: 'reasoning', text: delta.reasoning_content }
  }
  if (typeof delta.content === 'string' && delta.content !== '') {
    yield { type: 'text', text: delta.content }
  }
  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    yield {
      type: 'tool-call',
      id: call.id ?? `call_${call.index ?? 0}`,
      name: call.function?.name,
      argumentsDelta: typeof call.function?.arguments === 'string' ? call.function.arguments : '',
    }
  }
  const reason = choice.finish_reason
  if (typeof reason === 'string' && reason !== '') {
    yield { type: 'finish', reason: mapOpenAiFinish(reason) }
  }
}

export function mapOpenAiFinish(reason) {
  if (reason === 'tool_calls' || reason === 'function_call') return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

export function mapOpenAiUsage(usage) {
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : input + output,
    ...(typeof usage.prompt_tokens_details?.cached_tokens === 'number' ? { cacheReadTokens: usage.prompt_tokens_details.cached_tokens } : {}),
    ...(typeof usage.completion_tokens_details?.reasoning_tokens === 'number' ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens } : {}),
  }
}

/**
 * 把规范化事件流折成一次完整结果。
 *
 * 非流式协议（以及 `stream:false` 的调用）需要一次完整答案：文本拼接、工具调用
 * 按 id 聚合参数、usage 与 finish 取最后一个。工具调用的 id 可能分片重复出现
 * （OpenAI 的 delta 只在首片带 id），所以按 id 归并而不是按序号。
 */
export async function collect(events) {
  const toolOrder = []
  const tools = new Map()
  let text = ''
  let reasoning = ''
  let usage
  let finish = { kind: 'stop' }
  for await (const event of events) {
    switch (event.type) {
      case 'text':
        text += event.text
        break
      case 'reasoning':
        reasoning += event.text
        break
      case 'tool-call': {
        const key = event.id
        let current = tools.get(key)
        if (current === undefined) {
          current = { id: event.id, name: event.name ?? '', arguments: '' }
          tools.set(key, current)
          toolOrder.push(key)
        }
        if (event.name !== undefined && event.name !== '') current.name = event.name
        current.arguments += event.argumentsDelta ?? ''
        break
      }
      case 'usage':
        usage = event.usage
        break
      case 'finish':
        finish = event.reason
        break
      default:
        break
    }
  }
  return {
    text,
    reasoning,
    toolCalls: toolOrder.map((key) => tools.get(key)),
    usage,
    finish,
  }
}

/** 一个规范化失败原因 → OpenAI 的 finish_reason。 */
export function openAiFinishReason(finish, hasToolCalls) {
  if (hasToolCalls) return 'tool_calls'
  if (finish.kind === 'max-tokens') return 'length'
  return 'stop'
}

/** 一个规范化失败原因 → Anthropic 的 stop_reason。 */
export function anthropicStopReason(finish, hasToolCalls) {
  if (hasToolCalls) return 'tool_use'
  if (finish.kind === 'max-tokens') return 'max_tokens'
  return 'end_turn'
}

/** 一个规范化失败原因 → Gemini 的 finishReason。 */
export function geminiFinishReason(finish, hasToolCalls) {
  if (hasToolCalls) return 'STOP'
  if (finish.kind === 'max-tokens') return 'MAX_TOKENS'
  return 'STOP'
}
