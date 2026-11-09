// tool-desc-pin —— 工具「说明文本」改了，别把请求开头的 tools 重写
//
// 为什么：工具 description 一改，DSH 会把请求开头的 tools 整段换成新定义，
// 前缀缓存直接作废，一整轮上下文（几十万 token）按全价重算。
//
// 为什么钉在 tools.register()：dsh-llm 的 projectToolUpdates 要调用方传 toolHistory，
// 而这版里没人传（history 永远 undefined），所以 in-history / addition-only 那套等于死代码。
// 唯一稳的地方是注册表本身：按工具名把第一次注册时的 description 冻住，**落盘**（跨重启有效），
// 之后再注册同名工具、说明变了也照样返回旧说明；改动只记日志（globalThis + 文件）。
//
// 想让某条新说明真正生效：删掉 home\xykp\tool-desc-pin\freeze.json 里那一条（或整个文件）再重启。
// 只管说明文本；parameters 变了一律放行（那是真换 schema，该重写就重写）。

const TARGET = 'D:\\AI\\DeepseekHarness\\npm\\node_modules\\@deepseek-ai\\dsh-tools\\lib\\index.js'

const MARKER = 'ykp patch · tool-desc-pin'

const ANCHOR = `\tregister(definition) {
\t\tconst name = definition.name;`

const PATCHED = `\tregister(definition) {
\t\t// ── ${MARKER}（2026-10-29）──
\t\t// 说明文本按工具名冻住并落盘：之后再注册同名工具、description 变了也用冻住那版，
\t\t// 请求开头的 tools 不变 → 前缀缓存不废。变更只记日志，不动定义。
\t\ttry {
\t\t\tconst fs = globalThis.process?.getBuiltinModule?.('node:fs');
			try { fs?.mkdirSync('D:\\\\AI\\\\DeepseekHarness\\\\home\\\\xykp\\\\tool-desc-pin', { recursive: true }); } catch { }
\t\t\tconst jsonPath = 'D:\\\\AI\\\\DeepseekHarness\\\\home\\\\xykp\\\\tool-desc-pin\\\\freeze.json';
\t\t\tconst store = (globalThis.__ykpFrozenTools ||= (() => {
\t\t\t\ttry {
\t\t\t\t\treturn new Map(Object.entries(JSON.parse(fs.readFileSync(jsonPath, 'utf8'))));
\t\t\t\t}
\t\t\t\tcatch {
\t\t\t\t\treturn new Map();
\t\t\t\t}
\t\t\t})());
\t\t\tconst desc = typeof definition?.description === 'string' ? definition.description : void 0;
\t\t\tif (desc !== void 0 && typeof definition?.name === 'string') {
\t\t\t\tconst first = store.get(definition.name);
\t\t\t\tif (first === void 0) {
\t\t\t\t\tstore.set(definition.name, desc);
\t\t\t\t\ttry {
\t\t\t\t\t\tfs?.writeFileSync(jsonPath, JSON.stringify(Object.fromEntries(store), null, 2));
\t\t\t\t\t}
\t\t\t\t\tcatch { }
\t\t\t\t}
\t\t\t\telse if (first !== desc) {
\t\t\t\t\tconst change = { at: (new Date()).toISOString(), name: definition.name, builtin: Boolean(typeof WIRE_TRIMS !== 'undefined' && WIRE_TRIMS && WIRE_TRIMS[definition.name]), before: first.slice(0, 400), after: desc.slice(0, 400) };
\t\t\t\t\t(globalThis.__ykpToolDescChanges ||= []).push(change);
\t\t\t\t\ttry {
\t\t\t\t\t\tfs?.appendFileSync('D:\\\\AI\\\\DeepseekHarness\\\\home\\\\xykp\\\\tool-desc-pin\\\\changes.log', JSON.stringify(change) + '\\n');
\t\t\t\t\t}
\t\t\t\t\tcatch { }
\t\t\t\t\tdefinition = { ...definition, description: first };
\t\t\t\t}
\t\t\t}
\t\t}
\t\tcatch { }
\t\tconst name = definition.name;`

export const id = 'dsh-tools/tool-desc-pin'

export const description = '工具说明按名字冻在第一次注册的版本上并落盘（守住请求前缀缓存），改动只记日志'

export const edits = [{
  target: TARGET,
  marker: MARKER,
  apply(text) {
    const hits = text.split(ANCHOR).length - 1
    if (hits !== 1) throw new Error(`tools.register() 锚点命中 ${hits} 次（要求正好 1 次）`)
    return text.replace(ANCHOR, PATCHED)
  },
  revert(text) {
    if (!text.includes(PATCHED)) return text
    return text.replace(PATCHED, ANCHOR)
  },
}]
