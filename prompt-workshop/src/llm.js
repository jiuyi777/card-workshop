// 使用写卡工坊相同的酒馆调用通道；不收集、保存或上传连接密钥。
import { formatWriterMessages, restoreMacros } from './core.js';
const ctx = () => SillyTavern.getContext();
const sleep = n => new Promise(r => setTimeout(r, n));
const shieldMacro = s => String(s ?? '').replace(/\{\{\s*user\s*\}\}/gi, '〔user_macro〕').replace(/\{\{\s*char\s*\}\}/gi, '〔char_macro〕');
let lastAt = 0;

export function listProfiles() {
  const c = ctx();
  return (c.extensionSettings?.connectionManager?.profiles || []).map(x => ({ id: x.id, name: x.name }));
}

export function listPresets() {
  try { return ctx().getPresetManager?.('openai')?.getAllPresets?.() || []; }
  catch { return []; }
}

export function getCurrentPreset() {
  try {
    const pm = ctx().getPresetManager?.('openai');
    const name = pm?.getSelectedPresetName?.();
    return name ? { name, preset: pm.getCompletionPresetByName?.(name) || pm.getPresetSettings?.(name) } : null;
  } catch { return null; }
}

function presetMessages(name) {
  if (!name) return [];
  try {
    const p = ctx().getPresetManager?.('openai')?.getCompletionPresetByName?.(name);
    if (!p) return [];
    const byId = new Map((p.prompts || []).map(x => [x.identifier, x]));
    const group = (p.prompt_order || []).find(x => String(x.character_id) === '100001') || p.prompt_order?.[0];
    return (group?.order || []).filter(x => x.enabled).map(x => byId.get(x.identifier))
      .filter(x => x && !x.marker && String(x.content || '').trim())
      .map(x => ({ role: ['system','user','assistant'].includes(x.role) ? x.role : 'system', content: x.content }));
  } catch { return []; }
}

function scrubResponse(resp) {
  const raw = typeof resp === 'string' ? resp : (resp?.content || resp?.message || resp?.text || '');
  let s = String(raw).replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  s = s.replace(/^```(?:xml|text|markdown)?\s*\n/i, '').replace(/\n?```\s*$/, '').trim();
  return restoreMacros(s);
}

export async function writePrompt({ draft, settings, onStatus = () => {}, abortSignal }) {
  const { system, user } = formatWriterMessages({ mode: draft.mode, request: draft.request, name: draft.name, previous: draft.content });
  if (!draft.request?.trim()) throw new Error('先填写创作需求。');
  const gap = Math.max(0, Number(settings.minInterval) || 0) * 1000;
  const profile = settings.apiProfile;
  const c = ctx();
  const pre = presetMessages(settings.writingPreset);
  const messages = [{ role: 'system', content: system }, ...pre, { role: 'user', content: user }]
    .map(m => ({ ...m, content: shieldMacro(m.content) }));
  const maxTokens = Number(settings.maxTokens) || Number(c.chatCompletionSettings?.openai_max_tokens) || 8192;
  const waitTimes = [5, 15, 30];
  for (let attempt = 0; attempt < 4; attempt++) {
    if (abortSignal?.aborted) throw new Error('已停止');
    const left = lastAt + gap - Date.now();
    if (left > 0) { onStatus('等待 API 调用间隔…'); await sleep(left); }
    lastAt = Date.now();
    try {
      onStatus('正在生成提示词…');
      let res;
      if (profile && c.ConnectionManagerRequestService) {
        const svc = c.ConnectionManagerRequestService;
        const payload = typeof svc.constructPrompt === 'function' ? svc.constructPrompt(messages, profile) : messages;
        res = await svc.sendRequest(profile, payload, maxTokens, { stream: false, extractData: true, includePreset: true }, {});
      } else {
        if (typeof c.generateRaw !== 'function') throw new Error('酒馆当前版本不支持 generateRaw，请在设置里选择连接配置文件。');
        res = await c.generateRaw({ prompt: messages, systemPrompt: '', responseLength: maxTokens, trimNames: false });
      }
      const result = scrubResponse(res);
      if (!result) throw new Error('API 返回空结果。');
      return result;
    } catch (e) {
      if (abortSignal?.aborted) throw new Error('已停止');
      const message = String(e?.message || e);
      if (!/429|too many|rate.?limit|quota|529|50[0234]|bad gateway|timeout|超时|频率/i.test(message) || attempt === 3) throw e;
      const sec = /429|quota|rate.?limit|频率/.test(message) ? [15, 30, 60][attempt] || 60 : waitTimes[attempt];
      for (let k = sec; k > 0; k--) {
        if (abortSignal?.aborted) throw new Error('已停止');
        onStatus(`${message.slice(0, 52)}，${k} 秒后重试…`);
        await sleep(1000);
      }
    }
  }
  throw new Error('多次调用失败。');
}
