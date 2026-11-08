/**
 * lib/local-tool.mjs —— 宿主 `@deepseek-ai/dsh-tools` 拿不到时的本地等价实现
 * ============================================================================
 * 🔴 为什么必须有（2026-10-26 事故）：
 *   memory_ins / memory_rm 用的是 `defineTool` 的「字段表」DSL
 *   （`parameters: { text: { type: 'string', required: true } }`）。宿主的 defineTool
 *   会把它编译成 JSON Schema；而本地等价实现原来**原样返回**，于是发给模型的
 *   parameters 没有顶层 `type: "object"`，DeepSeek 直接 400：
 *     Invalid schema for function 'memory_ins': schema must be a JSON Schema of
 *     'type: "object"', got 'type: null'.
 *   → 这里补上同一套 spec→JSON Schema 编译（required / enum / const / array items /
 *     object / oneOf / 注解），跟宿主 dsh-tools 的 parameterSchemaSpecToJsonSchema 对齐。
 * ============================================================================
 */

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

function authorError(path, message) {
  return new Error(`defineTool(${path}): ${message}`)
}

/** 一个字段定义 → 一个 JSON Schema 节点 */
function fieldToNode(field, path) {
  if (field === undefined || field === null) return {}
  if (typeof field !== 'object' || Array.isArray(field)) throw authorError(path, '字段定义必须是对象')
  if (Array.isArray(field.oneOf)) {
    return { oneOf: field.oneOf.map((entry, index) => fieldToNode(entry, path + '.oneOf[' + index + ']')) }
  }
  const node = {}
  const type = field.type
  if (type === 'json') {
    // 只带注解 = 不约束的 JSON
  } else if (type === 'array') {
    node.type = 'array'
    if (field.items !== undefined) node.items = fieldToNode(field.items, path + '.items')
  } else if (type === 'object') {
    node.type = 'object'
    const properties = {}
    const required = []
    for (const [key, child] of Object.entries(field.properties || {})) {
      properties[key] = fieldToNode(child, path + '.properties.' + key)
      if (child && child.required === true) required.push(key)
    }
    node.properties = properties
    if (required.length) node.required = required
    if (field.additionalProperties !== undefined) node.additionalProperties = field.additionalProperties === true
  } else if (SCALAR_TYPES.has(type)) {
    node.type = type
  } else {
    throw authorError(path, 'type 必须是 string/number/integer/boolean/null/array/object/json，或改用 oneOf（收到 ' + String(type) + '）')
  }
  if (Array.isArray(field.enum)) node.enum = field.enum.slice()
  if (field.const !== undefined) node.const = field.const
  if (typeof field.description === 'string') node.description = field.description
  if (typeof field.title === 'string') node.title = field.title
  return node
}

/** 字段表 DSL → 对象根的 JSON Schema（宿主 parameterSchemaSpecToJsonSchema 的等价实现） */
export function parameterSpecToJsonSchema(spec, path = 'parameters') {
  const properties = {}
  const required = []
  for (const [key, field] of Object.entries(spec || {})) {
    properties[key] = fieldToNode(field, path + '.' + key)
    if (field && field.required === true) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** 已经是 JSON Schema（有 object 根）就原样用，否则按字段表 DSL 编译 */
function normalizeParameters(parameters) {
  if (parameters && typeof parameters === 'object' && parameters.type === 'object' && parameters.properties) {
    return parameters
  }
  return parameterSpecToJsonSchema(parameters)
}

/** object 节点必须显式写 additionalProperties（沿用原来的作者校验，只查 output.schema） */
function checkOutputSchema(schema, where) {
  if (!schema || typeof schema !== 'object') return
  if (schema.type === 'object' && schema.additionalProperties === undefined) {
    throw new Error(`defineTool(${where}): 是 object 却没写 additionalProperties`)
  }
  for (const [key, value] of Object.entries(schema.properties || {})) {
    checkOutputSchema(value, `${where}.properties.${key}`)
  }
}

/**
 * 拿不到宿主 defineTool 时的等价实现：把 parameters 的字段表 DSL 编译成 JSON Schema，
 * 其余字段（output / execute / present*）原样返回。
 */
export function localDefineTool(options, log) {
  const parameters = normalizeParameters(options.parameters)
  checkOutputSchema(options.output?.schema, 'output.schema')
  log?.(`dsh-tools 拿不到 —— 用本地等价实现顶上了（工具 ${options.name}，parameters 已按字段表编译成 JSON Schema）`)
  return { ...options, parameters }
}
