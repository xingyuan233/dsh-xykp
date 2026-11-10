// tool-desc-pin —— 工具说明「变了就记下来」，不再冻结
//
// 2026-11-10 改版：
// - 前缀固定改成「会话级」：由 tooldesc-control 在每个会话第一次装配时给
//   tools / system-prompt sections 拍快照；新会话重新读当前工具定义，
//   不再被全局冻结的旧说明拖住（旧版会一直返回第一次注册的说明并落盘）。
// - 本补丁只做监视：同名工具再注册时，description / parameters 变了就完整记进
//   globalThis.__ykpToolDescChanges，并更新 globalThis.__ykpToolLive
//   （给被门控工具的下一次解锁注入用）。
// - tooldesc-control 在下一轮给模型发「工具说明已更新」（前缀不动）；
//   被 control 接管的工具不发通用通知，等下一次注入时直接带最新定义。

const TARGET = 'D:\\AI\\DeepseekHarness\\npm\\node_modules\\@deepseek-ai\\dsh-tools\\lib\\index.js'

const MARKER = 'ykp patch · tool-desc-pin'

const ANCHOR = `\tregister(definition) {
\t\tconst name = definition.name;`

const PATCHED = `\tregister(definition) {
\t\t// ── ${MARKER}（2026-11-10 监视器版：只记录，不改定义、不落盘冻结）──
\t\t// 前缀固定按会话做（tooldesc-control 首次装配拍快照）；这里只在这个工具被
\t\t// 重新注册、说明或参数变了的时候，把完整的新定义记下来，让 tooldesc-control
\t\t// 下一轮能发「工具说明已更新」（被门控的工具不在此列，等下次注入新定义）。
\t\ttry {
\t\t\tconst toolName = definition?.name;
\t\t\tif (typeof toolName === 'string') {
\t\t\t\tconst desc = typeof definition.description === 'string' ? definition.description : '';
\t\t\t\tlet params = '';
\t\t\t\ttry { params = JSON.stringify(definition.parameters ?? null); } catch { params = ''; }
\t\t\t\tconst live = (globalThis.__ykpToolLive ||= new Map());
\t\t\t\tconst prev = live.get(toolName);
\t\t\t\tlive.set(toolName, { description: desc, parameters: definition.parameters, paramsSig: params });
\t\t\t\tif (prev && (prev.description !== desc || prev.paramsSig !== params)) {
\t\t\t\t\tconst change = {
\t\t\t\t\t\tat: (new Date()).toISOString(),
\t\t\t\t\t\tname: toolName,
\t\t\t\t\t\tbuiltin: Boolean(typeof WIRE_TRIMS !== 'undefined' && WIRE_TRIMS && WIRE_TRIMS[toolName]),
\t\t\t\t\t\tbefore: String(prev.description || ''),
\t\t\t\t\t\tafter: desc,
\t\t\t\t\t\tparams: prev.paramsSig !== params ? params : '',
\t\t\t\t\t};
\t\t\t\t\tconst log = (globalThis.__ykpToolDescChanges ||= []);
\t\t\t\t\tlog.push(change);
\t\t\t\t\tif (log.length > 80) log.splice(0, log.length - 80);
\t\t\t\t\ttry {
\t\t\t\t\t\tconst fs = globalThis.process?.getBuiltinModule?.('node:fs');
\t\t\t\t\t\tconst dir = 'D:/AI/DeepseekHarness/home/xykp/tool-desc-pin';
\t\t\t\t\t\tfs?.mkdirSync(dir, { recursive: true });
\t\t\t\t\t\tfs?.appendFileSync(dir + '/changes.log', JSON.stringify(change) + '\\n');
\t\t\t\t\t} catch { }
\t\t\t\t}
\t\t\t}
\t\t}
\t\tcatch { }
\t\tconst name = definition.name;`

export const id = 'dsh-tools/tool-desc-pin'

export const description = '只监视工具说明/参数变更（完整记录）；前缀固定由 tooldesc-control 按会话做，新会话读最新定义'

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
