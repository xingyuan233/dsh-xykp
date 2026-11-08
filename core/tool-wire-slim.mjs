// 功能补丁：工具定义的传输形态（tool wire slim）
//
// 发给模型的 tool 定义从「完整 JSON Schema」改成一行散文参数表：
//   params: (file_path:string=文件路径; offset?:number=从第几行开始; limit?=2000, 最多几行)
//   接着是作者原本的 description 原文（原样保留）
//   input_schema 压成 {"type":"object"}
//
// 每个参数显示什么，由作者在原始定义里用标记控制（默认：不显示类型、显示描述、显示默认值）：
//   showType: true     显示类型         file_path:string
//   showDesc: false    不显示描述       （默认显示）
//   showDefault: false 不显示默认值     （默认显示）
// 格式：name?[:type][=默认值][, 描述]；没有默认值时描述写成 =描述；参数之间用「; 」分隔。
//
// 不动的东西：插件原始定义、defineTool 的闭包校验（仍用完整 schema）、工具执行逻辑。
// 副作用：tool.parametersFull 保留完整 schema，供以后 PTC / SDK 生成使用。
//
// 关掉：环境变量 DSH_TOOL_WIRE=off，或某个工具定义里写 compressionParameter: false。
export const id = 'dsh-tools/tool-wire-slim'
export const description = '工具定义改成一行 params 散文参数表 + 最小 input_schema'

const TARGET = 'D:\\AI\\DeepseekHarness\\npm\\node_modules\\@deepseek-ai\\dsh-tools\\lib\\index.js'

const ANCHORS = {
  authorKeys: '\tconst authorKeys = [...ANNOTATION_KEYS, ...task.allowRequired ? ["required"] : []];',
  defineTool: 'function defineTool(options) {',
  preamble:
    '\tconst parameters = parameterSchemaSpecToJsonSchema(options.parameters);\n\tconst outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);\n\tconst validate = (args) => validateJsonSchemaValue(parameters, args, "");',
  literal: '\tconst tool = {\n\t\tname: options.name,\n\t\tdescription: options.description,\n\t\tparameters,',
  tail: '\t};\n\tif (userProjectContent) tool.projectContent = (exec, result) => userProjectContent(exec, result);',
}

const HELPERS = `//#region dsh-patch tool-wire-slim
/** 传输形态：默认 slim；DSH_TOOL_WIRE=off 或单工具 compressionParameter: false 退出。 */
function wireEnabled(options) {
\tif (options.compressionParameter === false) return false;
\treturn String(globalThis.process?.env?.DSH_TOOL_WIRE ?? "").trim().toLowerCase() !== "off";
}
/** 参数类型名（只在 showType 时用）。 */
function wireTypeOf(node) {
\tif (typeof node.type === "string") return node.type;
\tif (Array.isArray(node.type)) return node.type.join("|");
\tif (node.oneOf !== void 0) return "oneOf";
\treturn "any";
}
/** 作者标记：缺省 showDesc=true、showDefault=true、showType=false。 */
function wireFlag(spec, key, fallback) {
\treturn spec !== null && typeof spec === "object" && typeof spec[key] === "boolean" ? spec[key] : fallback;
}
/** 一行参数表：name?[:type][=默认值][<描述]；参数之间用 "; " 分隔。 */
function wireParamsLine(schema, specs) {
\tconst properties = schema.properties ?? {};
\tconst keys = Object.keys(properties);
\tif (keys.length === 0) return "params: ()";
\tconst required = new Set(Array.isArray(schema.required) ? schema.required : []);
\tconst parts = keys.map((key) => {
\t\tconst node = properties[key] ?? {};
\t\tconst spec = specs[key] ?? {};
\t\tlet token = required.has(key) ? key : key + "?";
\t\tif (wireFlag(spec, "showType", false)) token += ":" + wireTypeOf(node);
\t\tconst hasDefault = wireFlag(spec, "showDefault", true) && Object.hasOwn(node, "default");
\t\tif (hasDefault) token += "=" + JSON.stringify(node.default);
\t\tif (wireFlag(spec, "showDesc", true)) {
\t\t\tconst desc = typeof node.description === "string" ? node.description.replace(/[。.]\\s*$/u, "").replace(/\\s+/gu, " ") : "";
\t\t\tif (desc.length > 0) token += "<" + desc;
\t\t}
\t\treturn token;
\t});
\treturn "params: (" + parts.join("; ") + ")";
}
/** 散文形态：params 行 + 作者原本的描述。 */
function wireDescription(options, schema, specs, enabled) {
\tif (!enabled) return options.description;
\tconst lines = [wireParamsLine(schema, specs)];
\tif (typeof options.description === "string" && options.description.length > 0) lines.push(options.description);
\treturn lines.join("\\n");
}
//#endregion dsh-patch tool-wire-slim
`

function apply(text) {
  for (const [name, anchor] of Object.entries(ANCHORS)) {
    const hits = text.split(anchor).length - 1
    if (hits !== 1) throw new Error(`anchor ${name} matched ${hits} times (expected 1)`)
  }

  let out = text.replace(ANCHORS.defineTool, HELPERS + ANCHORS.defineTool)

  out = out.replace(
    ANCHORS.authorKeys,
    '\tconst authorKeys = [...ANNOTATION_KEYS, ...task.allowRequired ? ["required", "showType", "showDesc", "showDefault"] : []];'
  )

  out = out.replace(
    ANCHORS.preamble,
    `\tconst parameters = parameterSchemaSpecToJsonSchema(options.parameters);
\tconst outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
\tconst wireOn = wireEnabled(options);
\tconst wireSpecs = options.parameters ?? {};
\tconst wireParameters = wireOn ? {
\t\ttype: "object"
\t} : parameters;
\tconst wireText = wireDescription(options, parameters, wireSpecs, wireOn);
\tconst validate = (args) => validateJsonSchemaValue(parameters, args, "");`
  )

  out = out.replace(
    ANCHORS.literal,
    `\tconst tool = {
\t\tname: options.name,
\t\tdescription: wireText,
\t\tparameters: wireParameters,`
  )

  out = out.replace(
    ANCHORS.tail,
    `\t};
\ttool.parametersFull = parameters;
\tif (userProjectContent) tool.projectContent = (exec, result) => userProjectContent(exec, result);`
  )

  return out
}

export const edits = [{ target: TARGET, marker: 'dsh-patch tool-wire-slim', apply }]
