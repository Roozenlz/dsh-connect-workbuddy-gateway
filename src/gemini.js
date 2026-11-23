/**
 * Gemini（generateContent / streamGenerateContent）协议。
 *
 * 路径两条都收：
 *   `POST /v1beta/models/{model}:generateContent`
 *   `POST /v1beta/models/{model}:streamGenerateContent`
 * 另外也收版本前缀 `/v1/`（有些 SDK 写死 v1），以及 `?key=` 之外无前缀的
 * `/models/...`（Gemini CLI 的写法）。
 *
 * 工具调用：`functionCall{name,args}` / `functionResponse{name,response}`。
 * SSE 模式下每个事件是一条 `data: {...}`，与 Google 的 httpOptions 一致。
 */

import { readJson, sendJson, openSse, failureOf } from './util.js'
import { internalRequest } from './internal.js'
import { fromGeminiDeclaration } from './tools.js'
import { collect, geminiFinishReason } from './stream.js'
import { resolve } from './targets.js'
import { callModel } from './call.js'
import { withStatus } from './backend.js'
import { abortSignalOf, splitImageUrl } from './openai-chat.js'

/**
 * 从路径里拆出 `{model, action}`；不是 Gemini 路径时返回 undefined。
 *
 * 接受的前缀比官方多那么几个，因为各家 SDK 拼法不同：
 *
 *   `/v1beta/models/<m>:generateContent`      Google 官方
 *   `/v1/models/<m>:generateContent`          有的客户端版本写死 v1
 *   `/anthropic/v1beta/models/<m>:…`          客户端把 base 填成了带 /anthropic 的
 *   `/v1/v1beta/models/<m>:…`                 照抄文档时把 /v1 一起带上了
 *
 * 后面两种在真实客户端里都出现过，与其让用户自己删前缀，不如全都收下 —— 它们
 * 语义相同，多认一条只是少一次 404。
 */
export function parseGeminiPath(pathname) {
  const match = /^(?:\/(?:v1beta|v1|anthropic|openai|gemini))*\/models\/(.+?)(?::(generateContent|streamGenerateContent))\/?$/u.exec(pathname)
  if (match === null) return undefined
  return { model: decodeURIComponent(match[1]), action: match[2] }
}

/** 解析 generateContent 请求体。 */
export function parseGenerateRequest(body) {
  if (body === null || typeof body !== 'object') {
    throw withStatus(new Error('request body must be a JSON object'), 400, 'invalid_request_error')
  }
  let system
  const systemInstruction = body.systemInstruction ?? body.system_instruction
  if (systemInstruction !== undefined && systemInstruction !== null) {
    system = joinParts(systemInstruction.parts ?? systemInstruction)
  }
  const messages = []
  for (const content of Array.isArray(body.contents) ? body.contents : []) {
    const role = content?.role === 'model' ? 'assistant' : 'user'
    const parts = Array.isArray(content?.parts) ? content.parts : []
    if (role === 'assistant') {
      let text = ''
      const toolCalls = []
      for (const part of parts) {
        if (typeof part?.text === 'string') text += part.text
        else if (part?.functionCall !== undefined) {
          toolCalls.push({
            id: part.functionCall.id ?? `call_${toolCalls.length}`,
            name: part.functionCall.name ?? '',
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          })
        }
      }
      messages.push({ role: 'assistant', text, toolCalls })
      continue
    }
    const blocks = []
    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text !== '') {
        blocks.push({ type: 'text', text: part.text })
        continue
      }
      if (part?.inlineData !== undefined || part?.inline_data !== undefined) {
        const data = part.inlineData ?? part.inline_data
        if (typeof data?.data === 'string') {
          blocks.push({ type: 'image', mediaType: data.mimeType ?? data.mime_type ?? 'image/png', data: data.data })
        }
        continue
      }
      if (part?.functionResponse !== undefined) {
        const response = part.functionResponse
        messages.push({
          role: 'tool',
          toolCallId: response.id ?? response.name ?? 'unknown',
          text: typeof response.response === 'string' ? response.response : JSON.stringify(response.response ?? {}),
          isError: false,
        })
      }
    }
    if (blocks.length > 0) messages.push({ role: 'user', content: blocks })
  }
  if (messages.length === 0) {
    throw withStatus(new Error('contents must contain at least one entry'), 400, 'invalid_request_error')
  }
  const declarations = []
  for (const entry of Array.isArray(body.tools) ? body.tools : []) {
    for (const declaration of Array.isArray(entry?.functionDeclarations) ? entry.functionDeclarations : []) {
      const tool = fromGeminiDeclaration(declaration)
      if (tool !== undefined) declarations.push(tool)
    }
  }
  const generation = body.generationConfig ?? body.generation_config ?? {}
  return internalRequest({
    model: '',
    system,
    messages,
    tools: declarations.length === 0 ? undefined : declarations,
    temperature: typeof generation.temperature === 'number' ? generation.temperature : undefined,
    topP: typeof generation.topP === 'number' ? generation.topP : typeof generation.top_p === 'number' ? generation.top_p : undefined,
    maxTokens: typeof generation.maxOutputTokens === 'number'
      ? generation.maxOutputTokens
      : typeof generation.max_output_tokens === 'number' ? generation.max_output_tokens : undefined,
    stop: normalizeStopList(generation.stopSequences ?? generation.stop_sequences),
    reasoningEffort: effortFromGemini(generation.thinkingConfig ?? generation.thinking_config),
    stream: false,
  })
}

function effortFromGemini(config) {
  if (config === null || typeof config !== 'object') return undefined
  if (config.thinkingBudget === 0 || config.thinking_budget === 0) return 'off'
  const level = config.thinkingLevel ?? config.thinking_level
  if (typeof level !== 'string') return undefined
  const lower = level.toLowerCase()
  return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(lower) ? lower : undefined
}

function normalizeStopList(value) {
  if (!Array.isArray(value)) return undefined
  const kept = value.filter((entry) => typeof entry === 'string' && entry !== '')
  return kept.length === 0 ? undefined : kept
}

function joinParts(parts) {
  if (!Array.isArray(parts)) return ''
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).filter((text) => text !== '').join('\n\n')
}

/** 处理一次 generateContent / streamGenerateContent。 */
export async function handleGenerate(req, res, env, parsed) {
  const body = await readJson(req)
  const request = parseGenerateRequest(body)
  /*
   * 路径里的模型名只在这条协议里出现（Gemini 的端点形状如此）。它若为空
   * ——例如客户端只想用 key 的策略——就交给策略决定；`models/-` 是显式的
   * 「不指定」写法。
   */
  const requested = parsed.model === '-' ? '' : parsed.model
  const target = resolve(env.providers(), env.key, requested, env.config)
  const modelName = requested === '' ? target.model : requested
  const signal = abortSignalOf(res, req)
  const stream = parsed.action === 'streamGenerateContent'

  if (!stream) {
    const result = await collect(callModel(env.ctx, env, target, request, signal))
    sendJson(res, 200, geminiResponse(result, modelName))
    return
  }

  const sse = openSse(res)
  try {
    /*
     * Gemini 的流式响应是「每个事件一整条 GenerateContentResponse」。为了不把
     * 文本拆成逐 token 的海量事件（Gemini 客户端通常按事件累积），这里按 32 字符
     * 或遇到工具调用 / 结束时把缓冲刷出去。
     */
    let buffer = ''
    let sawToolCalls = false
    let usage
    const flush = (extra) => {
      if (buffer === '' && extra === undefined) return
      sse.data({
        candidates: [{
          content: { role: 'model', parts: [...(buffer === '' ? [] : [{ text: buffer }])] },
          ...(extra === undefined ? {} : extra),
        }],
        ...(usage === undefined ? {} : { usageMetadata: geminiUsage(usage, modelName) }),
      })
      buffer = ''
    }
    for await (const event of callModel(env.ctx, env, target, request, signal)) {
      if (event.type === 'text') {
        buffer += event.text
        if (buffer.length >= 32) flush()
        continue
      }
      if (event.type === 'reasoning') continue
      if (event.type === 'tool-call') {
        sawToolCalls = true
        if (event.id !== undefined && event.name !== undefined && event.name !== '') {
          if (buffer !== '') flush()
          sse.data({
            candidates: [{
              content: {
                role: 'model',
                parts: [{
                  functionCall: {
                    id: event.id,
                    name: event.name,
                    args: safeJson(event.argumentsDelta),
                  },
                }],
              },
            }],
          })
        }
        continue
      }
      if (event.type === 'usage') {
        usage = event.usage
        continue
      }
      if (event.type === 'finish') {
        flush({ finishReason: geminiFinishReason(event.reason, sawToolCalls) })
      }
    }
    flush()
  } catch (error) {
    const failure = failureOf(error)
    sse.data({ error: { code: failure.status, message: failure.message, status: geminiStatus(failure.status) } })
  } finally {
    sse.end()
  }
}

function geminiStatus(status) {
  if (status === 400) return 'INVALID_ARGUMENT'
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 403) return 'PERMISSION_DENIED'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RESOURCE_EXHAUSTED'
  if (status >= 500) return 'INTERNAL'
  return 'UNKNOWN'
}

function geminiResponse(result, modelName) {
  const parts = []
  if (result.reasoning !== '') parts.push({ text: result.reasoning, thought: true })
  if (result.text !== '') parts.push({ text: result.text })
  for (const call of result.toolCalls) {
    parts.push({ functionCall: { id: call.id, name: call.name, args: safeJson(call.arguments) } })
  }
  if (parts.length === 0) parts.push({ text: '' })
  return {
    candidates: [{
      content: { role: 'model', parts },
      finishReason: geminiFinishReason(result.finish, result.toolCalls.length > 0),
      index: 0,
    }],
    ...(result.usage === undefined ? {} : { usageMetadata: geminiUsage(result.usage, modelName) }),
    modelVersion: modelName,
  }
}

function geminiUsage(usage, modelName) {
  return {
    promptTokenCount: usage.inputTokens ?? 0,
    candidatesTokenCount: usage.outputTokens ?? 0,
    totalTokenCount: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    ...(usage.cacheReadTokens === undefined ? {} : { cachedContentTokenCount: usage.cacheReadTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { thoughtsTokenCount: usage.reasoningTokens }),
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text === '' ? '{}' : text)
  } catch {
    return {}
  }
}

/** 模型目录（Gemini 形状）。 */
export function geminiCatalog(entries) {
  return {
    models: entries.map((entry) => ({
      name: `models/${entry.id}`,
      displayName: entry.name ?? entry.id,
      description: '',
      ...(entry.contextWindow === undefined ? {} : { inputTokenLimit: entry.contextWindow }),
      ...(entry.maxTokens === undefined ? {} : { outputTokenLimit: entry.maxTokens }),
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    })),
  }
}

export { splitImageUrl }
