/** 统一内部请求 → 上游 OpenAI Chat 形状的请求体（直连通道用）。 */

/** 一个图片块 → `image_url` 分块。 */
function imagePart(block) {
  const prefix = typeof block.data === 'string' && block.data.startsWith('data:') ? '' : `data:${block.mediaType};base64,`
  return { type: 'image_url', image_url: { url: `${prefix}${block.data}` } }
}

/**
 * 投影成上游请求体。
 * @param request 统一内部请求
 * @param model 上游真实模型 id
 * @param options.stream 是否要求 SSE
 */
export function toOpenAiChatBody(request, model, options = {}) {
  const messages = []
  if (request.system !== undefined && request.system !== '') {
    messages.push({ role: 'system', content: request.system })
  }
  for (const message of request.messages) {
    if (message.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.text ?? '' })
      continue
    }
    if (message.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: typeof message.text === 'string' ? message.text : '',
        ...(message.toolCalls === undefined || message.toolCalls.length === 0 ? {} : {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
            },
          })),
        }),
      })
      continue
    }
    const parts = []
    for (const block of message.content) {
      if (block.type === 'text') {
        if (block.text !== '') parts.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type === 'image') parts.push(imagePart(block))
    }
    const onlyText = parts.every((part) => part.type === 'text')
    messages.push({ role: 'user', content: onlyText ? parts.map((part) => part.text).join('') : parts })
  }

  return {
    model,
    messages,
    stream: options.stream === true,
    ...(request.tools === undefined || request.tools.length === 0 ? {} : {
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          ...(tool.description === '' ? {} : { description: tool.description }),
          parameters: tool.parameters,
        },
      })),
    }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    ...(request.stop === undefined ? {} : { stop: request.stop }),
    ...(options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort }),
    ...(options.stream === true ? { stream_options: { include_usage: true } } : {}),
  }
}
