// 写卡工坊 · 联动八股清理
// 八股清理装在同一个扩展目录下时，直接读它的规则引擎和“我的八股词”，按它的整句修改方式改写。
// 没装就跳过这一步。

let engine = null;
let tried = false;

const CANDIDATES = ['bagu-cleaner', 'bagu-cleaner-main', 'baguCleaner', '八股清理'];

export async function loadBagu(base = import.meta.url) {
    if (engine || tried) return engine;
    tried = true;
    for (const dir of CANDIDATES) {
        try {
            engine = await import(new URL(`../../${encodeURIComponent(dir)}/engine.js`, base).href);
            if (engine?.editTargets) return engine;
        } catch { /* 下一个 */ }
        engine = null;
    }
    return null;
}

/** 测试用：直接注入引擎 */
export function setBaguEngine(e) { engine = e; tried = true; }
export const hasBagu = () => !!engine;

/** 用八股清理自己的设置组规则（我的八股词、自定义规则、分组开关都生效） */
export function baguOptions(extensionSettings) {
    if (!engine) return null;
    const s = extensionSettings?.baguCleaner ?? {};
    const { rules, errors } = engine.buildRules({
        ruleOverrides: s.ruleOverrides ?? {},
        disabledGroups: s.disabledGroups ?? [],
        customRules: s.customRules ?? '',
        userWords: s.userWords ?? '',
    });
    return { rules, errors, protectQuotes: s.protectQuotes ?? true, aiPrompt: s.aiPrompt };
}

export function baguScan(text, opts) {
    if (!engine || !opts) return { total: 0, must: 0, top: [] };
    return engine.scanText(text, opts);
}

/**
 * 只改含八股的整句，其余一字不动。call(system, prompt) 负责调 API。
 * @returns {Promise<{text:string, changed:number, failed:string[]}>}
 */
export async function baguRewrite(text, kind, opts, call, isAborted = () => false) {
    if (!engine || !opts) return { text, changed: 0, failed: [] };
    const targets = engine.editTargets(text, opts, false);
    if (!targets.length) return { text, changed: 0, failed: [] };
    const pref = opts.aiPrompt || engine.DEFAULT_AI_PROMPT;
    const sys = pref.includes(engine.EDIT_CONTRACT) ? pref : `${pref}\n\n${engine.EDIT_CONTRACT}`;
    const must = (v) => engine.mustHits(v, opts);
    const validate = (t, v) => engine.editIssue(t, v)
        || (v === t.text && t.hits.length ? '这句还没改' : '')
        || (must(v).length ? `还含必改词：${[...new Set(must(v).map((h) => h.match))].join('、')}` : '');
    const replacements = new Map();
    const failed = [];
    for (let i = 0; i < targets.length; i += 10) {
        if (isAborted()) break;
        const batch = targets.slice(i, i + 10);
        const prompt = `【任务】下面是${kind}里含八股的句子，逐句修改。能删的套路词删掉；删了不通顺或丢内容的，整句改写成自然的说法。长短不限。整句只是空套路的，text 填空字符串。
【格式】只输出 JSON：{"edits":[{"id":"s1","text":"改好的句子"}]}，每个 id 都要有。
【句子】
${JSON.stringify(batch.map((t) => ({ id: t.id, 句子: t.text, 八股: t.hits.map((h) => h.match), 前一句: t.prev, 后一句: t.next })), null, 1)}`;
        let edits = new Map();
        try { edits = engine.parseEdits(await call(sys, prompt)); } catch { /* 逐句重做 */ }
        for (const t of batch) {
            if (isAborted()) break;
            let v = edits.get(t.id);
            if (!validate(t, v)) { replacements.set(t.id, v); continue; }
            const retry = `【文本类型】${kind}
【前一句】${t.prev || '（无）'}
【要改的句子】${t.text}
【后一句】${t.next || '（无）'}
【这句里的八股】${t.hits.map((h) => h.match).join('、') || '（无）'}
把这句改好：能删的删，删了不通顺就改写，长短不限。只输出改好的这一句；整句是空套路就输出 ""。`;
            try {
                v = String(await call(sys, retry)).trim();
                if (v === '""' || v === '“”') v = '';
            } catch { v = undefined; }
            if (validate(t, v)) failed.push(t.text.slice(0, 30)); else replacements.set(t.id, v);
        }
    }
    return { text: engine.applyEdits(text, targets, replacements), changed: replacements.size, failed };
}
