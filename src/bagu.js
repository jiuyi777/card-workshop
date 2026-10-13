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
export function baguOptions(extensionSettings, extraWords = []) {
    if (!engine) return null;
    const s = extensionSettings?.baguCleaner ?? {};
    const { rules, errors } = engine.buildRules({
        ruleOverrides: s.ruleOverrides ?? {},
        disabledGroups: s.disabledGroups ?? [],
        customRules: s.customRules ?? '',
        userWords: [s.userWords ?? '', ...extraWords].join('\n'),
    });
    return { rules, errors, protectQuotes: s.protectQuotes ?? true, aiPrompt: s.aiPrompt };
}

/**
 * 扫描。words 是文中真正命中的片段（不是规则的写法），必改的排前面。
 * @returns {{total:number, must:number, top:any[], words:{text:string,must:boolean,count:number}[]}}
 */
export function baguScan(text, opts) {
    if (!engine || !opts) return { total: 0, must: 0, top: [], words: [] };
    const r = engine.scanText(text, opts);
    const map = new Map();
    let hits = [];
    try { hits = engine.hitList ? engine.hitList(text, opts) : []; } catch { hits = []; }
    for (const h of hits) {
        const t = String(h.match ?? '').trim();
        if (!t) continue;
        const v = map.get(t) ?? { text: t, must: false, count: 0 };
        v.count++;
        v.must ||= h.type === 'must';
        map.set(t, v);
    }
    // 规则有重叠时（“骨节分明”和“骨节分明的”）只留长的
    const all = [...map.values()];
    const words = all.filter((w) => !all.some((o) => o !== w && o.text.length > w.text.length && o.text.includes(w.text)))
        .sort((x, y) => Number(y.must) - Number(x.must) || y.count - x.count);
    return { ...r, words };
}

/** “嘴角勾起一抹弧度、战栗×2…” */
export function wordsText(words, n = 8, skip = []) {
    const list = (words ?? []).filter((w) => !skip.includes(w.text));
    const shown = list.slice(0, n).map((w) => (w.count > 1 ? `${w.text}×${w.count}` : w.text)).join('、');
    return list.length > n ? `${shown} 等 ${list.length} 种` : shown;
}

/**
 * 只改含八股的整句，其余一字不动。call(system, prompt) 负责调 API。
 * @returns {Promise<{text:string, changed:number, failed:string[]}>}
 */
export async function baguRewrite(text, kind, opts, call, isAborted = () => false, more = {}) {
    const [r] = await baguRewriteMany([{ text, kind }], opts, call, isAborted, more);
    return r;
}

/**
 * 好几块一起改：所有块里要改的句子合在一起，每批 batch 句发一次，不按块分批。
 * 第一轮没过检查的句子（原样交回、还带必改词、宏丢了），合在一起再发一轮，说明上次哪里不对。
 * onlyMust=true 时只改含必改词（禁用词、我的八股词）的句子。
 * @param {{text:string, kind:string}[]} items
 * @returns {Promise<{text:string, changed:number, failed:string[]}[]>}
 */
export async function baguRewriteMany(items, opts, call, isAborted = () => false, { onlyMust = false, batch = 12, onProgress } = {}) {
    const out = items.map((it) => ({ text: it.text, changed: 0, failed: [] }));
    if (!engine || !opts) return out;
    const must = (v) => engine.mustHits(v, opts);
    const per = items.map((it) => {
        let ts = engine.editTargets(it.text, opts, false);
        if (onlyMust) ts = ts.filter((t) => must(t.text).length);
        return ts;
    });
    const all = per.flatMap((ts, bi) => ts.map((t) => ({ t, bi, gid: `b${bi + 1}${t.id}`, kind: items[bi].kind })));
    if (!all.length) return out;
    const pref = opts.aiPrompt || engine.DEFAULT_AI_PROMPT;
    const sys = pref.includes(engine.EDIT_CONTRACT) ? pref : `${pref}\n\n${engine.EDIT_CONTRACT}`;
    const kinds = [...new Set(items.map((it) => it.kind))];
    const validate = (t, v) => engine.editIssue(t, v)
        || (v === t.text && t.hits.length ? '这句还没改，原样交回来了' : '')
        || (must(v).length ? `还含必改词：${[...new Set(must(v).map((h) => h.match))].join('、')}` : '');
    const done = new Map(); // gid → 改好的句子
    const why = new Map(); // gid → 上次的问题
    const rounds = Math.ceil(all.length / batch);
    let sent = 0;

    async function send(list, retry) {
        for (let i = 0; i < list.length; i += batch) {
            if (isAborted()) return;
            const part = list.slice(i, i + batch);
            sent++;
            onProgress?.({ sent, rounds, retry, sentences: all.length });
            const prompt = `【任务】下面是${kinds.join('、')}里含八股的句子，逐句修改。能删的套路词删掉；删了不通顺或丢内容的，整句改写成自然的说法。长短不限。整句只是空套路的，text 填空字符串。${retry ? '\n这些句子上次没改好，“上次的问题”写了原因，这次一定要避开。' : ''}
【格式】只输出 JSON：{"edits":[{"id":"b1s1","text":"改好的句子"}]}，每个 id 都要有。
【句子】
${JSON.stringify(part.map((x) => ({
                id: x.gid,
                ...(kinds.length > 1 ? { 类型: x.kind } : {}),
                句子: x.t.text,
                八股: x.t.hits.map((h) => h.match),
                ...(retry && why.get(x.gid) ? { 上次的问题: why.get(x.gid) } : {}),
                前一句: x.t.prev,
                后一句: x.t.next,
            })), null, 1)}`;
            let edits = new Map();
            // 整批格式错了整批重来一次
            for (let k = 0; k < 2 && !edits.size; k++) {
                if (isAborted()) return;
                try { edits = engine.parseEdits(await call(sys, prompt)); } catch { edits = new Map(); }
            }
            for (const x of part) {
                const v = edits.get(x.gid);
                const bad = validate(x.t, v);
                if (bad) why.set(x.gid, bad); else { done.set(x.gid, v); why.delete(x.gid); }
            }
        }
    }

    await send(all, false);
    const left = all.filter((x) => !done.has(x.gid));
    if (left.length && !isAborted()) await send(left, true);

    per.forEach((ts, bi) => {
        const rep = new Map();
        for (const x of all) if (x.bi === bi && done.has(x.gid)) rep.set(x.t.id, done.get(x.gid));
        out[bi] = {
            text: rep.size ? engine.applyEdits(items[bi].text, ts, rep) : items[bi].text,
            changed: rep.size,
            failed: all.filter((x) => x.bi === bi && !done.has(x.gid)).map((x) => x.t.text.slice(0, 30)),
        };
    });
    return out;
}

/** 像规则/提示词的条目（本身就列着禁用词），八股清理跳过 */
export function isInstructions(text) {
    try { return !!engine?.looksLikeInstructions?.(text); } catch { return false; }
}
