// 写卡工坊 · 解析 AI 返回、宏保护（不依赖 DOM）

import { USER_TOKEN } from './prompts.js';

export const CHAR_TOKEN = '〔char〕';

/** 去掉思考过程和外层代码块 */
export function tidy(raw) {
    return String(raw ?? '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/^\s*```[a-zA-Z]*\s*\n/, '')
        .replace(/\n?```\s*$/, '')
        .trim();
}

/** 宽松解析 JSON：去代码块，截取最外层花括号，去尾逗号，修中文引号做键 */
export function parseJSON(raw) {
    const text = tidy(raw);
    const tries = [text];
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
    for (const t of [...tries]) tries.push(t.replace(/,\s*([}\]])/g, '$1'));
    for (const t of tries) {
        try { return JSON.parse(t); } catch { /* 继续试 */ }
    }
    throw new Error('AI 返回的不是有效的 JSON');
}

const MARK = /^[ \t]*<<<\s*([^:：|>]+?)\s*(?:[:：]\s*([^|>]*?)\s*)?(?:\|\s*([^>]*?)\s*)?>>>[ \t]*$/gm;

/**
 * 按 <<<类型:名称|关键词1,关键词2>>> 分块。
 * @returns {{lead:string, blocks:{type:string,name:string,keys:string[],body:string}[]}}
 */
export function splitBlocks(text) {
    const src = tidy(text);
    const blocks = [];
    let lead = '';
    let last = null;
    let pos = 0;
    for (const m of src.matchAll(MARK)) {
        const chunk = src.slice(pos, m.index);
        if (last) last.body = chunk.trim(); else lead = chunk.trim();
        last = {
            type: m[1].trim(),
            name: (m[2] ?? '').trim(),
            keys: String(m[3] ?? '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
            body: '',
        };
        blocks.push(last);
        pos = m.index + m[0].length;
    }
    const tail = src.slice(pos);
    if (last) last.body = tail.trim(); else lead = tail.trim();
    return { lead, blocks };
}

/** 取某类型的第一块正文 */
export function blockOf(parsed, type) {
    return parsed.blocks.find((b) => b.type === type)?.body ?? '';
}

/**
 * 发给 AI 前把玩家/角色宏换成占位符，避免被酒馆替换成名字。
 * <user>、{{user}} → 〔user〕；<bot>、{{char}} → 〔char〕
 */
export function shield(text) {
    return String(text ?? '')
        .replace(/\{\{\s*user\s*\}\}/gi, USER_TOKEN)
        .replace(/<user>/gi, USER_TOKEN)
        .replace(/\{\{\s*char\s*\}\}/gi, CHAR_TOKEN)
        .replace(/<bot>/gi, CHAR_TOKEN);
}

/** AI 返回后换回来：〔user〕→ userToken（默认 <user>），〔char〕→ {{char}} */
export function unshield(text, userToken = '<user>') {
    return String(text ?? '')
        .replaceAll(USER_TOKEN, userToken)
        .replaceAll('[user]', userToken)
        .replaceAll(CHAR_TOKEN, '{{char}}');
}

/** 取 <名字>…</名字> 的内容（含标签），找不到返回原文 */
export function extractTagged(text, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = String(text ?? '').match(new RegExp(`<${esc}>[\\s\\S]*?</${esc}>`));
    return m ? m[0] : String(text ?? '').trim();
}

/** 截断长文本，给提示词当上下文用 */
export function clip(text, max = 1500) {
    const s = String(text ?? '').trim();
    return s.length > max ? `${s.slice(0, max)}\n……（以下省略）` : s;
}
