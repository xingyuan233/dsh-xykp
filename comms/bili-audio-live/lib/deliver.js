/**
 * bili-audio-live :: delivery
 * Push a batch of live-room text into a bound conversation as a real user message.
 * Ported from bili-reply (same host contracts, different source kind).
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { idForms } from './bind.js';

export const SOURCE_KIND = 'plugin:bili-audio-live';

/** Find the live agent for a session id (id may or may not carry the session- prefix). */
export function findAgent(ctx, sessionId) {
  for (const id of idForms(sessionId)) {
    try {
      const a = ctx.agents.get(id);
      if (a) return a;
    } catch {
      /* unqueryable form, try the next one */
    }
  }
  return null;
}

function defaultAgentOptions(ctx) {
  try {
    const dm = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null;
    const sel = dm && typeof dm.currentSelection === 'function' ? dm.currentSelection() : null;
    if (sel && sel.provider && sel.model) {
      const out = { provider: sel.provider, model: sel.model };
      if (sel.reasoningEffort) out.reasoningEffort = sel.reasoningEffort;
      return out;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Session exists on disk but is not open: resume it before pushing. */
export async function resumeAgent(ctx, sessionId, log = () => {}) {
  const agents = ctx && ctx.agents;
  if (!agents || typeof agents.resume !== 'function') return null;
  try {
    const resumeOptions = { resumeSessionId: String(sessionId), source: SOURCE_KIND };
    const agentOptions = defaultAgentOptions(ctx);
    if (agentOptions) resumeOptions.agentOptions = agentOptions;
    const handle = await agents.resume(resumeOptions);
    const agent = (handle && handle.agent) || findAgent(ctx, sessionId);
    if (!agent) return null;
    // A resumed agent has no preset mounted, so the turn would not run.
    try {
      const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : null;
      const header = agent?.session?.header;
      const want = String(header?.agentPreset || header?.preset || '');
      const has = presets && typeof presets.composedPreset === 'function' ? presets.composedPreset(agent.ctx) : '';
      if (presets && want && !has && typeof presets.mount === 'function') {
        await presets.mount(agent.ctx, want);
        log(`[deliver] resume 后补挂预设 ${want}`);
      }
    } catch (e) {
      log(`[deliver] 补挂预设失败: ${e.message}`);
    }
    return typeof agent.followup === 'function' ? agent : null;
  } catch (e) {
    log(`[deliver] 恢复会话 ${sessionId} 失败: ${e.message}`);
    return null;
  }
}

/**
 * Deliver one text batch. Must await followup: an unhandled rejection here
 * takes the whole host down.
 */
export async function deliver(ctx, sessionId, text, log = () => {}) {
  if (!sessionId) throw new Error('没有绑定会话');
  let agent = findAgent(ctx, sessionId);
  let resumed = false;
  if (!agent) {
    agent = await resumeAgent(ctx, sessionId, log);
    resumed = Boolean(agent);
  }
  if (!agent) throw new Error(`会话 ${sessionId} 不在了`);
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND },
  });
  await agent.followup(message);
  return { delivered: true, resumed };
}
