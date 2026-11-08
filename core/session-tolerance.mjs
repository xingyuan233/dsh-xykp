// 功能补丁：会话日志容错（session-tolerance）
//
// 背景：dsh 的 session-persistence-jsonl 在列举会话时，只要有一个文件读取失败
// （比如归档目录改名后 header id 对不上），就把整个 list() 抛错，导致
// workspace / session-controller / directoryPicker 一串服务全部挂掉。
//
// 改成：单个文件读失败 → console.warn 打一行日志，跳过该文件，其余会话照常加载。
export const id = 'session-persistence-jsonl/session-tolerance'
export const description = '单条会话日志读不出来时跳过它并打日志，不再拖垮整个会话列表'

const TARGET = 'D:\\AI\\DeepseekHarness\\npm\\node_modules\\@deepseek-ai\\dsh-session-persistence-jsonl\\lib\\index.js'

// 官方版：catch 里只放过两种「格式不支持/损坏」，其余一律 rethrow
const CATCH = /(?<ind>[ \t]*)\} catch \(error\) \{\s*if \(error instanceof SessionFormatUnsupportedError \|\| error instanceof SessionPersistenceCorruptionError\) return \{\s*selected,\s*metadata: void 0\s*\};\s*throw error;\s*\}/

// 补丁版：整块兜住
const PATCHED = /(?<ind>[ \t]*)\} catch \(error\) \{\s*\/\/ \[local patch\][\s\S]*?metadata: void 0\s*\};?\s*\}/

/** 用匹配到的缩进拼块文本。 */
function block(ind, lines) {
  return lines.map((line) => (line.length === 0 ? '' : ind + line)).join('\n')
}

function apply(text) {
  const m = text.match(CATCH)
  if (!m) throw new Error('patch site not found (catch block changed in a new release?)')
  const ind = m.groups.ind
  const body = block(ind, [
    '} catch (error) {',
    '\t// [local patch] A single unreadable session log must never take down the',
    '\t// whole session/workspace registry. Log it and skip just that artifact.',
    '\tconst reason = error instanceof Error ? error.message : String(error);',
    '\tconsole.warn(`dsh: warning: skipping unreadable session log ${selected.sourcePath}: ${reason}`);',
    '\treturn {',
    '\t\tselected,',
    '\t\tmetadata: void 0',
    '\t};',
    '}',
  ])
  return text.replace(CATCH, () => body)
}

function revert(text) {
  const m = text.match(PATCHED)
  if (!m) throw new Error('patched block not found — 无法反推官方原文，请从 npm 重新取')
  const ind = m.groups.ind
  const body = block(ind, [
    '} catch (error) {',
    '\tif (error instanceof SessionFormatUnsupportedError || error instanceof SessionPersistenceCorruptionError) return {',
    '\t\tselected,',
    '\t\tmetadata: void 0',
    '\t};',
    '\tthrow error;',
    '}',
  ])
  return text.replace(PATCHED, () => body)
}

export const edits = [{ target: TARGET, marker: '[local patch]', apply, revert }]
