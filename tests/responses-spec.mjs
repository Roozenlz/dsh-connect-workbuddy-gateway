/**
 * OpenAI Responses 流式响应的规范校验器。
 *
 * 这个文件把「标准 Responses 流必须满足什么」写成了可执行的断言，来源是 OpenAI
 * 官方的事件契约，而不是某个客户端的实现：
 *
 *   - 每个事件带 `sequence_number`，从 0 起严格递增；
 *   - `response.created` 只出现一次，且是第一个事件；
 *   - 任何非 terminal 事件都在 `response.created` 之后；
 *   - item 必须先 `output_item.added` 才能被 delta 引用；
 *   - `content_part.added` 的 part 必须与 `content_part.done` 的完全一致；
 *   - `output_item.done` 的 item 必须与 delta 累积结果一致；
 *   - terminal 事件的 `response.output` 必须与已宣告的 item 同序、同数、同内容；
 *   - terminal 之后不再有事件。
 *
 * 用它来测「我们的流是不是标准的」，比对着某个客户端的私有实现改更可靠。
 */

/** 一次校验的全部违规项。 */
export function validateResponsesStream(payloads) {
  const problems = []
  const note = (message) => problems.push(message)

  let lastSequence = -1
  let sawCreated = false
  let terminal = false
  const items = new Map()
  const closed = new Set()
  const closedParts = new Set()

  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value !== null && typeof value === 'object') {
      return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
    }
    return JSON.stringify(value)
  }

  for (const [offset, payload] of payloads.entries()) {
    const where = `event #${offset} (${payload?.type ?? '?'})`

    if (!Number.isInteger(payload?.sequence_number)) {
      note(`${where}: missing sequence_number`)
      continue
    }
    if (payload.sequence_number <= lastSequence) {
      note(`${where}: sequence_number ${payload.sequence_number} is not greater than ${lastSequence}`)
    }
    lastSequence = payload.sequence_number

    if (terminal) {
      note(`${where}: event after the terminal event`)
      continue
    }

    if (payload.type === 'response.created') {
      if (sawCreated) note(`${where}: duplicate response.created`)
      sawCreated = true
      continue
    }
    if (!sawCreated) {
      note(`${where}: event before response.created`)
      continue
    }

    if ('response' in payload && payload.response !== null && typeof payload.response === 'object') {
      const response = payload.response
      if (typeof response.id !== 'string') note(`${where}: response has no id`)
      if (!Array.isArray(response.output)) note(`${where}: response.output is not an array`)
      if (payload.type.startsWith('response.') && ['completed', 'incomplete', 'failed'].includes(payload.type.slice('response.'.length))) {
        const wanted = payload.type.slice('response.'.length)
        if (response.status !== wanted) note(`${where}: status ${String(response.status)} disagrees with the event`)
        const declared = [...items.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item)
        if ((response.output ?? []).length !== declared.length) {
          note(`${where}: terminal output has ${(response.output ?? []).length} items but ${declared.length} were announced`)
        }
        for (const [index, item] of declared.entries()) {
          const final = response.output[index]
          if (final?.id !== item.id) note(`${where}: terminal output[${index}] id ${String(final?.id)} != ${item.id}`)
        }
        terminal = true
      }
      continue
    }

    if (payload.type === 'error') continue

    if (payload.type === 'response.output_item.added') {
      if (payload.item === null || typeof payload.item !== 'object') {
        note(`${where}: item is not an object`)
        continue
      }
      if (items.has(payload.output_index)) note(`${where}: duplicate output_index ${payload.output_index}`)
      items.set(payload.output_index, structuredClone(payload.item))
      continue
    }

    const item = items.get(payload.output_index)
    if (item === undefined) {
      note(`${where}: refers to output_index ${payload.output_index} before it was added`)
      continue
    }
    if (closed.has(payload.output_index)) note(`${where}: update after output_item.done`)
    if (payload.item_id !== undefined && payload.item_id !== item.id) {
      note(`${where}: item_id ${payload.item_id} != ${item.id}`)
    }

    if (payload.type === 'response.output_item.done') {
      if (payload.item?.id !== item.id) note(`${where}: done item id changed`)
      if (item.type === 'function_call') {
        if (payload.item?.arguments !== item.arguments) {
          note(`${where}: done arguments ${JSON.stringify(payload.item?.arguments)} != ${JSON.stringify(item.arguments)}`)
        }
      }
      for (const field of ['content', 'summary']) {
        if (Array.isArray(item[field]) && item[field].length > 0) {
          if (canonical(item[field]) !== canonical(payload.item?.[field])) {
            note(`${where}: done ${field} disagrees with deltas`)
          }
        }
      }
      items.set(payload.output_index, structuredClone(payload.item))
      closed.add(payload.output_index)
      continue
    }

    if (payload.type === 'response.function_call_arguments.delta') {
      if (item.type !== 'function_call') note(`${where}: arguments delta on a ${item.type} item`)
      item.arguments = (item.arguments ?? '') + payload.delta
      continue
    }
    if (payload.type === 'response.function_call_arguments.done') {
      if (payload.arguments !== item.arguments) {
        note(`${where}: final arguments disagree with deltas`)
      }
      closedParts.add(`${item.id}/arguments`)
      continue
    }

    /* 内容分片：text / reasoning 两条通道。 */
    const index = typeof payload.content_index === 'number' ? payload.content_index : -1
    if (index < 0) {
      note(`${where}: missing content_index`)
      continue
    }
    const parts = (item.content ??= [])
    const key = `${item.id}/${index}`
    if (payload.type === 'response.content_part.added') {
      if (parts[index] !== undefined) note(`${where}: duplicate content part ${key}`)
      parts[index] = structuredClone(payload.part)
      continue
    }
    if (payload.type === 'response.content_part.done') {
      if (parts[index] === undefined) note(`${where}: done for an unadded part ${key}`)
      else if (canonical(parts[index]) !== canonical(payload.part)) {
        note(`${where}: done part disagrees with the added part`)
      }
      closedParts.add(key)
      continue
    }
    if (parts[index] === undefined) {
      note(`${where}: delta before content_part.added (${key})`)
      continue
    }
    if (closedParts.has(key)) note(`${where}: delta after content_part.done`)

    const field = payload.type.startsWith('response.reasoning') ? 'text' : 'text'
    if (typeof payload.delta === 'string') {
      parts[index][field] = (parts[index][field] ?? '') + payload.delta
    } else if (typeof payload.text === 'string') {
      if (parts[index][field] !== payload.text) note(`${where}: final text disagrees with deltas`)
      closedParts.add(key)
    }
  }

  if (!sawCreated) note('stream never sent response.created')
  if (!terminal) note('stream never sent a terminal event')
  return problems
}

/**
 * 把一段 SSE 文本拆成事件 payload 数组。
 *
 * 换行两种都收：`\n\n` 与 `\r\n\r\n`。后者在 Windows 上会被某些中间层改写，
 * 只认一种就会让「解析出 0 个事件」，看起来像服务没响应。
 *
 * @param text 原始 SSE
 */
export function parseSseEvents(text) {
  const normalized = String(text).replaceAll('\r\n', '\n')
  const out = []
  for (const frame of normalized.split('\n\n')) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('')
    if (data === '' || data === '[DONE]') continue
    try {
      out.push(JSON.parse(data))
    } catch {
      /* 半帧，忽略 */
    }
  }
  return out
}
