// 写卡工坊 · 调用 API
// - 连接：酒馆当前连接，或“连接配置文件”里的任意一个
// - 预设：可以给“写卡”和“开场白”分别绑定一个对话补全预设，插件取出预设里启用的提示词条目一起发送
// - 宏保护：发送前把 <user>/{{user}}/{{char}} 换成占位符，收到后换回来

import { shield, unshield, tidy } from './parse.js';

const ctx = () => SillyTavern.getContext();

export function listProfiles() {
    const c = ctx();
    if (!c.ConnectionManagerRequestService) return [];
    return (c.extensionSettings?.connectionManager?.profiles ?? []).map((p) => ({ id: p.id, name: p.name }));
}

export function listPresets() {
    try {
        const pm = ctx().getPresetManager?.('openai');
        return pm?.getAllPresets?.() ?? [];
    } catch { return []; }
}

/** 取对话补全预设里启用的提示词条目（跳过聊天记录、角色描述这类占位条目） */
export function presetMessages(name) {
    if (!name) return [];
    try {
        const pm = ctx().getPresetManager?.('openai');
        const p = pm?.getCompletionPresetByName?.(name);
        if (!p) return [];
        const byId = new Map((p.prompts ?? []).map((x) => [x.identifier, x]));
        const order = (p.prompt_order ?? []).find((o) => String(o.character_id) === '100001') ?? (p.prompt_order ?? [])[0];
        const list = order?.order?.length
            ? order.order.filter((o) => o.enabled).map((o) => byId.get(o.identifier)).filter(Boolean)
            : (p.prompts ?? []).filter((x) => x.enabled !== false);
        return list
            .filter((x) => !x.marker && String(x.content ?? '').trim())
            .map((x) => ({ role: ['system', 'user', 'assistant'].includes(x.role) ? x.role : 'system', content: String(x.content) }));
    } catch (e) {
        console.warn('[写卡工坊] 读取预设失败', e);
        return [];
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastAt = 0;

const errText = (e) => [e?.message, e?.cause?.message, e?.status, e?.cause?.status, e?.cause?.cause?.message, String(e ?? '')].filter(Boolean).join(' ');

/** 429 / 频率限制 / 配额 */
export function isRateLimit(e) {
    return /429|too many|rate.?limit|频率|过于频繁|quota|resource.?exhausted|overloaded|529/i.test(errText(e));
}

/** 服务器临时出错：500/502/503/504、网关超时、断网、连接被重置。通常重试就好 */
export function isTransient(e) {
    if (isRateLimit(e)) return false;
    return /\b50[0234]\b|bad gateway|gateway time-?out|service unavailable|internal server error|upstream|timed? ?out|timeout|failed to fetch|network ?error|networkerror|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|terminated|unknown error occurred|网关|超时|服务.{0,4}不可用/i.test(errText(e));
}

/** 给状态栏和报错用的简短原因 */
export function errorKind(e) {
    if (isRateLimit(e)) return '429（请求太频繁）';
    const m = errText(e).match(/\b(50[0234])\b/);
    if (m) return `${m[1]}（服务器暂时出错）`;
    if (/bad gateway/i.test(errText(e))) return '502（服务器暂时出错）';
    if (/service unavailable/i.test(errText(e))) return '503（服务器暂时出错）';
    if (/time-?out|timed? ?out|超时/i.test(errText(e))) return '超时';
    return '连接出错';
}

/**
 * 调一次 API。两次调用之间至少隔 settings.minInterval 秒。
 * 遇到 429 自动等 15/30/60 秒重试；遇到 502 这类服务器临时错误等 5/15/30 秒重试。
 * @param {{system:string,user:string,stage:'card'|'greeting',temperature?:number,settings:any,userToken?:string,onWait?:(s:number,why:string)=>void,aborted?:()=>boolean}} o
 */
export async function callLLM(o) {
    const gap = Math.max(0, Number(o.settings?.minInterval ?? 3)) * 1000;
    const rateWaits = o.settings?.retryWaits ?? [15, 30, 60];
    const errWaits = o.settings?.errorWaits ?? [5, 15, 30];
    let rateTries = 0, errTries = 0;
    for (;;) {
        const left = lastAt + gap - Date.now();
        if (left > 0) await sleep(left);
        if (o.aborted?.()) throw new Error('已停止');
        lastAt = Date.now();
        try {
            return await callOnce(o);
        } catch (e) {
            if (o.aborted?.()) throw new Error('已停止');
            let sec;
            if (isRateLimit(e)) {
                if (rateTries >= rateWaits.length) throw new Error('API 一直返回 429（请求太频繁）。等一会儿再试，或者在设置里把“两次调用间隔”调大。');
                sec = rateWaits[rateTries++];
            } else if (isTransient(e)) {
                if (errTries >= errWaits.length) {
                    throw new Error(`API 一直返回 ${errorKind(e)}，重试 ${errWaits.length} 次都没成功。多半是 API 或中转站那边的问题，等几分钟再点一次（已经写好的不会丢），或者在设置里换一个连接配置文件。原始错误：${clipMsg(e)}`);
                }
                sec = errWaits[errTries++];
            } else {
                throw e;
            }
            const why = errorKind(e);
            for (let t = sec; t > 0; t--) {
                if (o.aborted?.()) throw new Error('已停止');
                o.onWait?.(t, why);
                await sleep(1000);
            }
        }
    }
}

const clipMsg = (e) => String(e?.message ?? e ?? '').slice(0, 160);

async function callOnce({ system, user, messages: convo, stage = 'card', temperature, settings, userToken = '<user>' }) {
    const c = ctx();
    const presetName = stage === 'greeting' ? settings.presetGreeting : settings.presetCard;
    const pre = presetMessages(presetName);
    const messages = [
        { role: 'system', content: shield(system) },
        ...pre.map((m) => ({ role: m.role, content: shield(m.content) })),
        // 多轮对话（试玩）传 messages，否则只有一条 user
        ...(convo?.length ? convo.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: shield(m.content) })) : [{ role: 'user', content: shield(user) }]),
    ];
    const maxTokens = Number(settings.maxTokens) || Number(c.chatCompletionSettings?.openai_max_tokens) || 8192;
    const profile = settings.apiProfile;
    let raw;
    if (profile && c.ConnectionManagerRequestService) {
        const svc = c.ConnectionManagerRequestService;
        const prompt = typeof svc.constructPrompt === 'function' ? svc.constructPrompt(messages, profile) : messages;
        const override = settings.useTemperature && typeof temperature === 'number' ? { temperature } : {};
        const res = await svc.sendRequest(profile, prompt, maxTokens, { stream: false, extractData: true, includePreset: true }, override);
        raw = typeof res === 'string' ? res : (res?.content ?? '');
    } else {
        if (typeof c.generateRaw !== 'function') throw new Error('当前酒馆版本没有 generateRaw');
        const responseLength = Number(settings.maxTokens) || null;
        raw = await c.generateRaw({ prompt: messages, systemPrompt: '', responseLength, trimNames: false });
    }
    const text = tidy(raw);
    if (!text) throw new Error('API 返回了空内容');
    return unshield(text, userToken);
}
