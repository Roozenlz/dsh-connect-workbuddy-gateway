/** 工具 schema 在三种方言之间互转。参数始终是 JSON Schema。 */

/**
 * OpenAI 的 `{type:'function', function:{name,description,parameters}}` → 统一的
 * `{name, description, parameters}`。
 */
export function fromOpenAiTool(tool) {
  if (tool === null || typeof tool !== 'object') return undefined
  const fn = tool.function ?? tool
  if (typeof fn?.name !== 'string' || fn.name === '') return undefined
  return {
    name: fn.name,
    description: typeof fn.description === 'string' ? fn.description : '',
    parameters: isSchema(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
  }
}

/** Anthropic 的 `{name, description, input_schema}` → 统一形状。 */
export function fromAnthropicTool(tool) {
  if (tool === null || typeof tool !== 'object') return undefined
  if (typeof tool.name !== 'string' || tool.name === '') return undefined
  return {
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: isSchema(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} },
  }
}

/** Gemini 的 `functionDeclarations[].{name,description,parameters}` → 统一形状。 */
export function fromGeminiDeclaration(declaration) {
  if (declaration === null || typeof declaration !== 'object') return undefined
  if (typeof declaration.name !== 'string' || declaration.name === '') return undefined
  return {
    name: declaration.name,
    description: typeof declaration.description === 'string' ? declaration.description : '',
    parameters: isSchema(declaration.parameters) ? declaration.parameters : { type: 'object', properties: {} },
  }
}

/** 统一的工具定义 → 宿主 `ToolSchema`。 */
export function toHostTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
}

/** 统一的工具定义 → OpenAI Chat 的 tool 描述。 */
export function toOpenAiTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...tool.description === '' ? {} : { description: tool.description },
      parameters: tool.parameters,
    },
  }
}

/** 统一的工具定义 → Anthropic 的 tool 描述。 */
export function toAnthropicTool(tool) {
  return {
    name: tool.name,
    ...tool.description === '' ? {} : { description: tool.description },
    input_schema: tool.parameters,
  }
}

/** 统一的工具定义 → Gemini 的 functionDeclaration。 */
export function toGeminiDeclaration(tool) {
  return {
    name: tool.name,
    ...tool.description === '' ? {} : { description: tool.description },
    parameters: sanitizeForGemini(tool.parameters),
  }
}

/**
 * 去掉 Gemini 不接受的 schema 关键字。
 *
 * Gemini 的 `parameters` 是 OpenAPI 的子集：它拒绝 `additionalProperties`、
 * `$schema`、`$ref`、`oneOf` 之类 JSON Schema 关键字，整字段拒收并让整个
 * 请求 400。这里做保守裁剪——保留 object/array/string/number/boolean 的类型
 * 与结构，其余丢弃。丢了比 400 好：模型看到的工具形状略有损失，但调用能发出去。
 */
export function sanitizeForGemini(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} }
  }
  const allowed = new Set(['type', 'description', 'properties', 'items', 'required', 'enum', 'format', 'nullable', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength'])
  const walked = (node) => {
    if (node === null || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(walked)
    const out = {}
    for (const [key, value] of Object.entries(node)) {
      if (!allowed.has(key)) continue
      out[key] = key === 'properties' && value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, walked(child)]))
        : walked(value)
    }
    return out
  }
  const cleaned = walked(schema)
  if (typeof cleaned.type !== 'string') cleaned.type = 'object'
  return cleaned
}

function isSchema(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
