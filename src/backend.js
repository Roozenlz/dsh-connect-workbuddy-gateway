/**
 * 宿主服务桥接层。
 *
 * 网关不碰 WorkBuddy 凭据：它把请求翻译成宿主的 `GenerateOptions`，交给既有
 * adapter 去鉴权、换号、规避渠道校验，再把 `StreamChunk` 翻译回各协议。
 */

import { regionOfProvider, providerOfRegion } from './resolve.js'

/** 一个 provider 的模型目录；失败返回空数组。 */
export async function listModels(ctx, provider) {
  const llm = ctx.get('llm')
  if (llm === undefined) return []
  try {
    return await llm.listModels(provider)
  } catch {
    return []
  }
}

/** 模型元信息；路由不存在时退化为目录里的一行。 */
export async function resolveModelInfo(ctx, provider, model) {
  const llm = ctx.get('llm')
  if (llm === undefined) return undefined
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return {
      id: info.id,
      name: info.name,
      contextWindow: info.context?.contextWindow,
      defaultMaxTokens: info.defaultMaxTokens,
      inputModalities: info.inputModalities,
      reasoning: info.reasoning,
    }
  } catch {
    const models = await listModels(ctx, provider)
    const found = models.find((entry) => entry.id === model)
    return found === undefined ? undefined : { id: found.id, name: found.name }
  }
}

/** workbuddy 系 provider 路由（配置显式声明优先，否则按前缀识别）。 */
export function workbuddyProviders(ctx, configured) {
  const declared = Array.isArray(configured) ? configured.filter((id) => typeof id === 'string' && id !== '') : []
  if (declared.length > 0) return declared
  const llm = ctx.get('llm')
  if (llm === undefined) return []
  return llm.listProviders()
    .map((entry) => entry.id)
    .filter((id) => regionOfProvider(id) !== undefined)
}

/** DSH 新会话的默认模型选择。 */
export function defaultSelection(ctx) {
  const service = ctx.get('agentDefaultModel')
  if (service === undefined) return undefined
  try {
    return service.currentSelection()
  } catch {
    return undefined
  }
}

/**
 * 最近一个活跃会话正在用的模型。
 *
 * 会话的 `requestHeader()` 记录了该会话当前请求头里的 provider/model，这是
 * 「用户此刻在 DSH 里用的那个」唯一可靠来源。
 */
export function sessionSelection(ctx) {
  const agents = ctx.get('agents')
  if (agents === undefined) return undefined
  let live
  try {
    live = agents.list()
  } catch {
    return undefined
  }
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const agent = live[index]
    let header
    try {
      header = agent?.session?.requestHeader?.()
    } catch {
      continue
    }
    const config = header?.config
    if (config !== undefined && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
    }
  }
  return undefined
}

/**
 * 把统一内部请求投影成宿主的 `GenerateOptions`。
 *
 * 每一步都不能省：
 *   - 图片必须换成 durable 附件引用（宿主 adapter 只认引用）；
 *   - tool 结果消息必须带 `toolCallId`；
 *   - assistant 消息必须带 `source: {kind:'model'}`
 *     （pi-ai 历史投影要求它，缺了整段历史会被判成 unsupported）。
 */
export async function buildGenerateOptions(ctx, config, request, target) {
  const messages = []
  const images = []
  for (const message of request.messages) {
    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        toolCallId: message.toolCallId,
        isError: message.isError === true,
        content: [{ type: 'text', text: message.text }],
      })
      continue
    }
    if (message.role === 'assistant') {
      const content = []
      if (typeof message.text === 'string' && message.text !== '') content.push({ type: 'text', text: message.text })
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          id: call.id,
          name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        })
      }
      if (content.length === 0) content.push({ type: 'text', text: '' })
      messages.push({
        role: 'assistant',
        content,
        source: { kind: 'model', provider: target.provider ?? 'workbuddy', model: target.model },
      })
      continue
    }
    /* user */
    const content = []
    for (const block of message.content) {
      if (block.type === 'text') {
        if (block.text !== '') content.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type === 'image') {
        const ref = await saveImage(ctx, block)
        images.push(ref)
        content.push({ type: 'image', attachment: ref })
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: '' })
    messages.push({ role: 'user', content })
  }

  const effort = request.reasoningEffort ?? target.reasoningEffort
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    ...(request.system === undefined || request.system === '' ? {} : { system: request.system }),
    ...(request.tools === undefined || request.tools.length === 0 ? {} : {
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(request.stop === undefined ? {} : { stop: request.stop }),
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  }
  return { options, images }
}

/** 把 base64 / data URL 图片存成 durable 附件引用。 */
export async function saveImage(ctx, block) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw withStatus(new Error('this profile has no attachment service, so image input cannot be forwarded'), 400, 'unsupported_input')
  }
  const comma = typeof block.data === 'string' ? block.data.indexOf(',') : -1
  const bare = typeof block.data === 'string' && block.data.startsWith('data:') && comma !== -1
    ? block.data.slice(comma + 1)
    : block.data
  try {
    return await attachments.saveImage({
      data: Buffer.from(bare, 'base64'),
      mediaType: block.mediaType,
    })
  } catch (error) {
    throw withStatus(new Error(`image input was refused: ${error instanceof Error ? error.message : String(error)}`), 400, 'invalid_image')
  }
}

/** 起一条模型流并逐个吐出 chunk。 */
export function streamHost(ctx, options, signal) {
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw withStatus(new Error('the host llm service is not mounted, so the gateway has no upstream to call'), 503, 'service_unavailable')
  }
  return llm.stream({ ...options, ...(signal === undefined ? {} : { signal }) })
}

/** 挂状态码与错误码。 */
export function withStatus(error, status, code) {
  error.status = status
  error.code = code
  return error
}

export { regionOfProvider, providerOfRegion }
