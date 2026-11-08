// 功能补丁：自带工具的描述精简（tool wire trims）
//
// 背景：@deepseek-ai 自带工具的描述有一堆废话（"Path to read, resolved by the filesystem backend."、
// "Maximum number of lines to return. Defaults to 2000."），每个字都进首轮 prompt。
// 这个补丁在 wire 生成前套一张表，按「工具名 → 描述 / 参数描述」覆盖。
//
// 依赖：必须先有 tool-wire-slim 补丁（它负责把 description 换成 params 行）。
// 表里 null = 该参数不显示描述；字符串 = 用这句替换；不写 = 保持原样。
//
// 文案约定：英文（和自带工具一致）、短句、不讲究语法客套，说清做什么就行。
//
// 改文案只改下面 TRIMS 表，然后：
//   pwsh -File patches\core\apply-all.ps1 -Restore
//   pwsh -File patches\core\apply-all.ps1
//   重启 dsh web
export const id = 'dsh-tools/tool-wire-trims'
export const description = '自带工具的描述/参数说明改成简短版，去掉废话'

const TARGET = 'D:\\AI\\DeepseekHarness\\npm\\node_modules\\@deepseek-ai\\dsh-tools\\lib\\index.js'
const MARKER = 'dsh-patch tool-wire-trims'

// 审批相关两兄弟在所有工具里文字一样，抽出来复用
const APPROVE = {
  sandbox_permissions: 'wider sandbox mode for a one-shot retry of the denied call',
  justification: "with sandbox_permissions: one sentence why, in the owner's language",
}
const TIMING = {
  after_seconds: 'fire once after N seconds',
  every_seconds: 'fixed interval (>=60s)',
  daily: 'every day at a local time',
  weekly: 'on given weekdays at a local time',
  cron: 'five-field cron',
  at: 'absolute time (RFC3339 with offset, or date+time+zone)',
}

export const TRIMS = {
  // ── files ───────────────────────────────────────────────────────────────
  read: {
    desc: 'Read a UTF-8 text file, returns line-numbered content.',
    // limit 的 2000 是代码里的默认，schema 没声明；这里补一个 default 只为了在 wire 上显示成 =2000
    params: { file_path: null, offset: 'start line (1-based)', limit: { desc: 'max lines', default: 2000 } },
  },
  write: {
    desc: 'Create or fully overwrite a UTF-8 file. Use edit for partial changes.',
    params: { file_path: null, content: null, ...APPROVE },
  },
  edit: {
    desc: 'Replace old_string with new_string in an existing file. Read the file first.',
    params: {
      file_path: null,
      old_string: null,
      new_string: null,
      replace_all: 'replace every match (default: old_string must be unique)',
      ...APPROVE,
    },
  },
  read_image: {
    desc: 'Read a PNG/JPEG/WebP/GIF and return the image itself (large images are downscaled).',
    params: { file_path: null },
  },
  glob: {
    desc: 'Find files by path glob (content is not searched). Up to 100 paths, newest first.',
    params: { pattern: 'path glob, e.g. **/*.ts; without / it matches the basename', path: 'search root, defaults to the workspace' },
  },
  grep: {
    desc: 'Search file contents with a ripgrep regex. Returns matching lines with line numbers, up to 250.',
    params: { pattern: null, path: null, include: 'only these files (one glob, e.g. *.ts)' },
  },
  pwsh: {
    desc:
      'Run a PowerShell command, returns stdout/stderr. Fresh process per call; use workdir instead of cd.\n' +
      'Long output is truncated to its tail; the full output goes to a file whose path is returned.\n' +
      'Windows paths use `C:\\...`; env vars `$env:NAME`. Check the absolute path before any delete or move.',
    params: {
      description: 'one line on what the command does (5-10 words, shown in UI)',
      command: null,
      timeoutMs: 'timeout in ms; on expiry it moves to the background',
      workdir: 'working directory, defaults to the workspace',
      run_in_background: 'run in the background, returns a job id',
      ...APPROVE,
    },
  },

  // ── task / delivery ─────────────────────────────────────────────────────
  todo_write: {
    desc: 'Replace the whole task list (not append). One todo per step; mark in_progress / completed as you go.',
    params: { todos: 'the complete list, replaces any previous' },
  },
  present: {
    desc: 'Mark existing files as deliverables (shown as cards; contents are not copied).',
    params: { files: 'the 1-2 most important, at most 4' },
  },
  ask_user_question: {
    desc: 'Ask the user to confirm, choose, or fill in missing info.',
    params: { questions: '1-4 questions, ask them all at once' },
  },

  // ── goals ───────────────────────────────────────────────────────────────
  create_goal: {
    desc: 'Create a goal that keeps working across rounds. For long-running work; skip for single-turn tasks.',
    params: { objective: "the completion objective from the owner's request", max_goal_rounds: 'cap on automatic rounds' },
  },
  get_goal: { desc: 'Read the current goal, including the id and revision update_goal needs.' },
  update_goal: {
    desc: 'Update the goal. edit/pause/resume need an explicit owner request; complete/blocked can be automatic.',
    params: {
      goal_id: null,
      revision: null,
      action: 'edit/pause/resume only on owner request; complete/blocked allowed',
      objective: 'action=edit only',
      max_goal_rounds: 'action=edit only',
      blocked_reason: 'action=blocked only: the concrete blocker',
    },
  },
  exit_plan_mode: {
    desc: 'Plan mode only: submit the plan for review; approval leaves plan mode.',
    params: { plan: 'full plan in markdown, first line is a # heading' },
  },

  // ── background jobs ─────────────────────────────────────────────────────
  job_kill: { desc: 'Cancel a background job.', params: { job_id: null, reason: 'short reason, logged' } },
  job_list: { desc: 'List background jobs (running and finished).' },
  job_output: {
    desc: "Read a job's new output, or the final result once it has finished.",
    params: { job_id: null, wait: 'block until it finishes', timeout_ms: 'max wait with wait: true' },
  },

  // ── subagents ───────────────────────────────────────────────────────────
  list_agents: { desc: 'List the subagents I started (id, label, status).', params: { scope: 'children (default) or descendants' } },
  interrupt_agent: { desc: 'Ask a subagent to stop; returns without waiting.', params: { agent_id: null } },
  send_message: {
    desc: 'Send a message to an agent: a running one gets it at its next step, an idle one starts a new turn.',
    params: { agent_id: null, message: null },
  },
  subagent: {
    desc: 'Delegate a self-contained task to a separate agent with no shared context. Returns its result only.',
    params: { cwd: 'child working directory', description: '3-5 word label, shown in UI', prompt: 'the full task; it cannot see this conversation' },
  },
  subagent_fork: {
    desc: 'Delegate a task to a subagent that inherits this conversation’s completed turns.',
    params: { cwd: null, description: null, prompt: 'only what is new; it already has the earlier turns' },
  },

  // ── web / skill ─────────────────────────────────────────────────────────
  web_search: { desc: 'Search the web for current information. Returns a summary plus source URLs.', params: { queries: '1-4 queries, results merged' } },
  web_fetch: { desc: 'Fetch a URL and return its body as text.', params: { url: null } },
  skill: {
    desc: 'Load a skill’s full instructions. Call it before acting on a task that matches a skill.',
    params: { name: 'the exact skill name' },
  },

  // ── orchestration ───────────────────────────────────────────────────────
  workflow: {
    desc:
      'Run a JS script that orchestrates subagents at scale (audits, migrations, multi-angle research).\n' +
      'Only when the owner explicitly asks for a workflow; use subagent for one or two delegations.\n' +
      'Script API: agent(prompt, opts) runs one subagent (opts.schema for structured output, null on failure); ' +
      'pipeline(items, ...stages) runs each item through its stages independently; parallel(thunks) awaits all; ' +
      'phase(title) / log(msg) report progress; args is this call’s args. No fs/network/timers in the script.',
    params: {
      script: 'plain JS body (not TS, no meta), end with return <value>',
      meta: 'workflow metadata (JSON)',
      args: 'args exposed to the script',
      run_in_background: 'run in the background, returns a job id',
    },
  },
  working_directory: { desc: 'Read the current working directory, or change it with cd.', params: { cd: 'directory to enter; omit to just read' } },

  // ── reminders ───────────────────────────────────────────────────────────
  schedule_create: {
    desc: 'Create a reminder in this session; prompt is delivered when due. Exactly one timing parameter.',
    params: {
      prompt: 'content shown when it fires',
      title: 'task name (<=120 chars; action and object only, no frequency/time/status)',
      ...TIMING,
    },
  },
  schedule_delete: { desc: 'Delete a reminder; already-queued messages are not retracted.', params: { id: null } },
  schedule_list: { desc: "List this session's reminders." },
  schedule_update: {
    desc: 'Change a reminder in place, keeping its id. At most one timing parameter.',
    params: { id: null, title: 'new name, same rules as schedule_create', prompt: 'new content', ...TIMING },
  },
}

const ANCHOR_WIRE_TEXT = '\tconst wireText = wireDescription(options, parameters, wireSpecs, wireOn);'
const ANCHOR_DEFINE_TOOL = 'function defineTool(options) {'

const WIRE_TEXT_PATCHED = `\tconst wireText = (() => {
\t\tconst trim = WIRE_TRIMS[options.name];
\t\tif (!wireOn || trim === void 0) return wireDescription(options, parameters, wireSpecs, wireOn);
\t\tconst trimmedOptions = trim.desc === void 0 ? options : {
\t\t\t...options,
\t\t\tdescription: trim.desc
\t\t};
\t\tconst trimmedSchema = trim.params === void 0 ? parameters : {
\t\t\t...parameters,
\t\t\tproperties: Object.fromEntries(Object.entries(parameters.properties ?? {}).map(([key, node]) => {
\t\t\t\tconst spec = trim.params[key];
\t\t\t\tif (spec === void 0) return [key, node];
\t\t\t\tconst next = {
\t\t\t\t\t...node
\t\t\t\t};
\t\t\t\tif (spec === null) next.description = void 0;
\t\t\t\telse if (typeof spec === "string") next.description = spec;
\t\t\t\telse {
\t\t\t\t\tif (spec.desc === null) next.description = void 0;
\t\t\t\t\telse if (typeof spec.desc === "string") next.description = spec.desc;
\t\t\t\t\tif (Object.hasOwn(spec, "default")) next.default = spec.default;
\t\t\t\t}
\t\t\t\treturn [key, next];
\t\t\t}))
\t\t};
\t\treturn wireDescription(trimmedOptions, trimmedSchema, wireSpecs, wireOn);
\t})();`

function apply(text) {
  if (!text.includes(ANCHOR_WIRE_TEXT)) {
    throw new Error('找不到 wireDescription 调用点：请先应用 tool-wire-slim 补丁')
  }
  if (text.split(ANCHOR_DEFINE_TOOL).length - 1 !== 1) throw new Error('defineTool 锚点不唯一')

  const table = '//#region ' + MARKER + '\nconst WIRE_TRIMS = ' + JSON.stringify(TRIMS) + ';\n//#endregion ' + MARKER + '\n'

  let out = text.replace(ANCHOR_DEFINE_TOOL, table + ANCHOR_DEFINE_TOOL)
  out = out.replace(ANCHOR_WIRE_TEXT, WIRE_TEXT_PATCHED)
  return out
}

export const edits = [{ target: TARGET, marker: MARKER, apply }]
