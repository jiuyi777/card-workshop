// 写卡工坊 · 各步骤的执行逻辑（不依赖 DOM，API 调用通过 call 注入，便于测试）

import { DEFAULT_PROMPTS, DEFAULT_RULES, RULE_META, CARD_MODES, PERSONA_TEMPLATE, SYSTEM_CARD, SYSTEM_PROSE, STEP_INFO, fill, ruleVars } from './prompts.js';
import { parseJSON, splitBlocks, blockOf, extractTagged, clip, stripWords, wordList, findWords } from './parse.js';
import { matchTags, sanitizeTags, toggleTag, tagsText, tagValue, libraryText, findTag, rollDice, PLATFORM_STYLE, dimOf } from './tags.js';
import { conceptText, answersText, overviewsText, routesText, composeIntro, parseTitles, orderedGreetings, DEFAULT_INTRO_STYLE, cardToDraft, existingSummary, emptyDraft, sentContext, contextText, CREDIT_WORKSHOP, CREDIT_TEMPLATE } from './assemble.js';
import { diffLines } from './diff.js';
import { scanCard, predictOverlap, crossCompare, mergeLifeStory, lifeStoryStats } from './checks.js';

const arr = (x) => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]);
const str = (x) => (x == null ? '' : String(x).trim());

export function normalizeConcept(c) {
    const lineup = arr(c?.lineup).map((p) => ({ name: str(p?.name) || '未命名', identity: str(p?.identity), archetype: arr(p?.archetype).map(str).filter(Boolean) }));
    let routes = arr(c?.routes).map((r) => ({ name: str(r?.name) || '主线', user: str(r?.user), period: str(r?.period) }));
    if (!routes.length) routes = [{ name: '主线', user: str(arr(c?.user)[0]), period: '' }];
    return {
        title: str(c?.title),
        lineup,
        user: arr(c?.user).map(str).filter(Boolean),
        relation: str(c?.relation),
        tension: { core: str(c?.tension?.core), expect: arr(c?.tension?.expect).map(str).filter(Boolean) },
        complexity: ['简单', '中等', '复杂'].includes(str(c?.complexity)) ? str(c.complexity) : '简单',
        reason: str(c?.reason),
        routes,
        npcs: Number.isFinite(Number(c?.npcs)) ? Math.max(0, Math.min(8, Number(c.npcs))) : 2,
        tags: arr(c?.tags).map(str).filter(Boolean),
    };
}

/**
 * @param {{ settings:()=>any, lib:()=>any, llm:(o:{system:string,user:string,stage:string,temperature?:number})=>Promise<string>, aborted?:()=>boolean, progress?:(m:string)=>void }} deps
 */
export function makeFlow(deps) {
    const S = () => deps.settings();
    const L = () => deps.lib();
    const progress = (m) => deps.progress?.(m);
    const aborted = () => deps.aborted?.() ?? false;
    const check = () => { if (aborted()) throw new Error('已停止'); };

    /** 卡的类型：作者在标签页选的优先；没选就看标签和主要角色人数 */
    function modeOf(d) {
        if (d?.mode && CARD_MODES[d.mode]) return d.mode;
        const ct = tagValue(d?.tags ?? [], 'cardType');
        if (ct.includes('世界卡')) return 'world';
        const cnt = tagValue(d?.tags ?? [], 'count');
        if (ct.includes('多人卡') || cnt.includes('NP') || cnt.includes('群像') || (d?.personas?.length ?? 0) > 1) return 'multi';
        return 'single';
    }

    /** 规则库里的每个模块：内置的 + 自己加的，带开关、用在哪种卡、额外插到哪些步骤 */
    function ruleList() {
        const s = S();
        const custom = s.customRules ?? {};
        const names = [...new Set([...Object.keys(DEFAULT_RULES), ...Object.keys(custom)])];
        return names.map((name) => {
            const builtin = name in DEFAULT_RULES;
            const text = builtin ? (str(s.rules?.[name]) ? s.rules[name] : DEFAULT_RULES[name]) : String(custom[name] ?? '');
            return {
                name, text, builtin,
                edited: builtin && !!str(s.rules?.[name]),
                on: !s.ruleOff?.[name],
                mode: s.ruleModes?.[name] ?? RULE_META[name]?.mode ?? 'all',
                steps: s.ruleSteps?.[name] ?? RULE_META[name]?.steps ?? [],
            };
        });
    }
    const ruleActive = (r, d) => r.on && (r.mode === 'all' || (d && r.mode === modeOf(d)));
    /** 提示词里 {{rules.名称}} 用的值：关掉的、卡类型不符的是空 */
    /** 插到这一步的规则模块（提示词里已经写了 {{rules.名称}} 的不重复加） */
    function ruleExtras(d, id) {
        const tpl = promptOf(id) ?? '';
        let out = '';
        for (const r of ruleList()) {
            if (!ruleActive(r, d) || !r.steps.includes(id) || !str(r.text) || tpl.includes(`{{rules.${r.name}}}`)) continue;
            out += `\n\n【规则·${r.name}】\n${r.text}`;
        }
        return out;
    }
    const rules = (d) => Object.fromEntries(ruleList().map((r) => [r.name, ruleActive(r, d) ? r.text : '']));
    const promptOf = (id) => (S().prompts?.[id]?.trim() ? S().prompts[id] : DEFAULT_PROMPTS[id]);
    const concept = (d) => d.concepts?.[d.pick] ?? null;
    const platform = (d) => tagValue(d.tags, 'platform').map((p) => `${p}：${PLATFORM_STYLE[p] ?? ''}`).join('；') || '主流网文，读者想一直读下去';
    const isPistol = (d) => tagValue(d.tags, 'cardType').includes('手枪卡');

    function baseVars(d) {
        return {
            idea: d.idea,
            tags: tagsText(d.tags, L()) || '（未选）',
            concept: concept(d) ? conceptText(concept(d)) : d.au ? auSummary(d) : (d.existing ? existingSummary(d) : ([str(d.idea) && `脑洞：${str(d.idea)}`, writtenText(d)].filter(Boolean).join('\n') || conceptText(null))),
            platform: platform(d),
            overviews: overviewsText(d),
            personas: clip((d.personas ?? []).map((p) => p.text).filter(Boolean).join('\n\n'), 6000),
            answers: answersText(d),
            world: clip([d.world?.main, ...(d.world?.extra ?? []).map((e) => e.content)].filter(Boolean).join('\n'), 2500) || '（无）',
            npcs: clip((d.npcs ?? []).map((n) => n.content).join('\n'), 2000) || '（无）',
            routes: routesText(d),
            tone: clip(d.tone, 1500) || '（无）',
            ...ruleVars(rules(d)),
            cardMode: CARD_MODES[modeOf(d)],
        };
    }

    /** 禁用词（去掉用户选了的标签名，比如选了“神明”就不禁“神明”） */
    const banned = (d) => {
        const tags = new Set((d.tags ?? []).map((t) => t.name));
        return wordList(rules()['禁用词']).filter((w) => !tags.has(w));
    };
    const withBan = (system, d) => {
        const list = banned(d);
        return list.length ? `${system}\n下面这些词一律不要出现，换成具体、平实的写法：${list.join('、')}` : system;
    };
    /** 生成的正文直接删掉程度副词（不调 API） */
    const strip = (text) => stripWords(text, rules()['直接删']);

    // ───── 修改意见 / 上一版 / 截断 ─────
    const feedbackOf = (d, key) => str(d.feedback?.[key]);

    /** 重写前把旧内容存进历史（每块最多 5 版） */
    function remember(d, key, value) {
        const empty = value == null || (typeof value === 'string' ? !value.trim() : Array.isArray(value) ? !value.length : !Object.values(value).some((v) => (typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.length : v)));
        if (empty) return;
        d.history ??= {};
        if (d.changes?.[key]) delete d.changes[key]; // 新的一版，旧的“改了什么”作废（改动类操作会在之后重新记）
        const list = (d.history[key] ??= []);
        list.push(structuredClone(value));
        if (list.length > 5) list.shift();
    }

    /** 每一块内容怎么读、怎么写回（给“换回上一版”用） */
    function slotOf(d, key) {
        const [kind, ...rest] = key.split(':');
        const name = rest.join(':');
        const persona = () => d.personas.find((x) => x.name === name);
        const fr = () => d.free.find((x) => x.name === name);
        return {
            idea: { get: () => ({ concepts: d.concepts, pick: d.pick }), set: (v) => { d.concepts = v.concepts; d.pick = v.pick; } },
            persona: { get: () => ({ overview: persona()?.overview ?? '', text: persona()?.text ?? '' }), set: (v) => { const p = persona(); if (p) Object.assign(p, v); } },
            world: { get: () => d.world, set: (v) => { d.world = v; } },
            npc: { get: () => d.npcs, set: (v) => { d.npcs = v; } },
            routes: { get: () => d.routes.map((r) => r.info), set: (v) => { d.routes.forEach((r, i) => { r.info = v[i] ?? r.info; }); } },
            tone: { get: () => d.tone, set: (v) => { d.tone = v; } },
            relations: { get: () => d.relations ?? '', set: (v) => { d.relations = v; } },
            greet: { get: () => d.greetings.filter((g) => g.route === name).map((g) => g.text), set: (v) => { d.greetings = [...d.greetings.filter((g) => g.route !== name), ...v.map((text) => ({ route: name, text }))]; } },
            free: { get: () => fr()?.content ?? '', set: (v) => { const f = fr(); if (f) f.content = v; } },
            intro: { get: () => d.intro, set: (v) => { d.intro = v; } },
            exist: existSlot(d, name),
            au: { get: () => (name === 'map' ? d.au?.map : { core: d.au?.core, shell: d.au?.shell }), set: (v) => { if (name === 'map') d.au.map = v; else { d.au.core = v.core; d.au.shell = v.shell; } } },
            route: { get: () => d.routes.find((r) => r.name === name)?.info ?? '', set: (v) => { const r = d.routes.find((x) => x.name === name); if (r) r.info = v; } },
        }[kind];
    }

    /** 原卡里的一段：exist:field:description / exist:entry:12 / exist:greet:0 */
    function existSlot(d, name) {
        const ex = d.existing;
        if (!ex) return undefined;
        const [type, id] = name.split(':');
        if (type === 'field') return { get: () => ex.fields[id] ?? '', set: (v) => { ex.fields[id] = v; } };
        if (type === 'entry') { const e = () => ex.entries.find((x) => String(x.uid) === id); return { get: () => e()?.content ?? '', set: (v) => { if (e()) e().content = v; } }; }
        if (type === 'greet') return { get: () => ex.greetings[Number(id)] ?? '', set: (v) => { ex.greetings[Number(id)] = v; } };
        return undefined;
    }

    /** 能“按意见改”的块：值是一段文字 */
    function textSlot(d, key) {
        const [kind, ...rest] = key.split(':');
        const name = rest.join(':');
        const labels = { persona: `人设·${name}`, world: '世界观', tone: '基调与规则', free: `模块·${name}`, route: `路线·${name}`, exist: name.startsWith('field:') ? { description: '角色描述', personality: '性格', scenario: '场景', mes_example: '对话示例' }[name.slice(6)] ?? name : name.startsWith('greet:') ? `开场白 ${Number(name.slice(6)) + 1}` : (d.existing?.entries.find((e) => `entry:${e.uid}` === name)?.comment ?? '条目') };
        if (kind === 'persona') { const p = d.personas.find((x) => x.name === name); return p && { label: labels.persona, get: () => p.text, set: (v) => { p.text = v; } }; }
        if (kind === 'world') return { label: labels.world, get: () => d.world.main, set: (v) => { d.world.main = v; } };
        if (kind === 'tone') return { label: labels.tone, get: () => d.tone, set: (v) => { d.tone = v; } };
        if (kind === 'relations') return { label: '角色关系', get: () => d.relations ?? '', set: (v) => { d.relations = v; } };
        const slot = slotOf(d, key);
        return slot && labels[kind] && { label: labels[kind], ...slot };
    }

    /** 按意见修改一段（已有的卡用，不从头重写） */
    async function revise(d, key) {
        const slot = textSlot(d, key);
        if (!slot) throw new Error('这一块不能按意见改');
        const fb = feedbackOf(d, key);
        if (!fb) throw new Error('先在“哪里不满意”里写意见');
        const text = slot.get();
        if (!str(text)) throw new Error('这一块是空的，没法改');
        const out = await run('revise', d, { label: slot.label, fb, text }, { styleKey: key });
        remember(d, key.startsWith('persona:') ? key : key, key.startsWith('persona:') ? { overview: d.personas.find((x) => x.name === key.slice(8))?.overview ?? '', text } : text);
        slot.set(out.trim());
        noteChanges(d, key, text, out.trim(), `按意见改：${fb.slice(0, 40)}`);
        d.feedback[key] = '';
        return d;
    }

    /** 给已有的卡想新路线（只出点子，作者点“加上”才算数） */
    async function suggestRoutes(d, n = 3) {
        const j = parseJSON(await run('newRoutes', d, { n }, { json: true }));
        d.routeIdeas = arr(j.routes).map((r) => ({ name: str(r?.name), user: str(r?.user), period: str(r?.period), why: str(r?.why) })).filter((r) => r.name);
        return d;
    }

    function addRouteIdea(d, i) {
        const r = d.routeIdeas?.[i];
        if (!r) return d;
        let name = r.name;
        for (let k = 2; d.routes.some((x) => x.name === name); k++) name = `${r.name}${k}`;
        d.routes.push({ name, user: r.user, period: r.period, info: '' });
        d.routeIdeas.splice(i, 1);
        return d;
    }

    // ───── AU ─────

    /** 原卡全文（给提取内核、映射表看） */
    function auOriginal(d, max = 9000) {
        const o = d.au?.original;
        if (!o) return '';
        const parts = [`卡名：${o.name}`];
        for (const p of o.personas) parts.push(`【人设·${p.name}】${p.overview ? `\n概要：${p.overview}` : ''}\n${clip(p.text, 3500)}`);
        if (o.world) parts.push(`【世界观】\n${clip(o.world, 1500)}`);
        for (const e of o.entries.slice(0, 8)) parts.push(`【${e.comment}】\n${clip(e.content, 500)}`);
        if (o.routes) parts.push(`【路线】\n${clip(o.routes, 800)}`);
        if (o.greeting) parts.push(`【开场白节选】\n${clip(o.greeting, 400)}`);
        return clip(parts.join('\n\n'), max);
    }

    const coreText = (d, name) => (d.au?.core ?? []).filter((c) => !name || c.name === name).map((c) => `${c.name}：\n${str(c.text)}`).join('\n\n');

    /** AU 草稿的“构想”：AU 设定 + 内核 + 映射表 */
    function auSummary(d) {
        const au = d.au;
        return [
            `这是《${au.original?.name ?? ''}》里角色的 AU：换了世界观和身份，人还是那个人。`,
            `【AU 设定】\n${str(d.idea) || '（还没写）'}${ideaAnswers(d) ? `\n${ideaAnswers(d)}` : ''}`,
            `【角色内核】（必须保留，行为要从这里长出来）\n${coreText(d) || '（还没提取）'}`,
            au.map ? `【映射表】（原作 → AU）\n${au.map}` : '',
            '写的时候只写 AU 世界里的样子：原作的地名、组织、道具、事件不要出现，除非映射表给了对应。AU 题材的套路可以用，但角色的反应来自内核，不要变成这个题材的默认角色。',
        ].filter(Boolean).join('\n\n');
    }

    /** 用一张已有的卡开一个 AU 新草稿（原卡不动） */
    function auStart(card, worldData, worldName) {
        const src = cardToDraft(card, worldData, worldName);
        const d = emptyDraft();
        d.name = `${src.name}（AU）`;
        d.nameAuto = false;
        d.tags = sanitizeTags(src.tags.map((t) => t.name), L()).filter((t) => ['cp', 'count', 'userGender', 'rating', 'platform'].includes(t.dim));
        d.personas = src.personas.map((p) => ({ name: p.name, keys: p.keys ?? [], overview: '', text: '' }));
        d.au = {
            original: {
                name: src.name,
                avatar: card?.avatar ?? '',
                personas: src.personas.map((p) => ({ name: p.name, overview: p.overview, text: p.text })),
                world: src.world.main,
                entries: [...src.world.extra.map((e) => ({ comment: e.name, content: e.content })), ...src.npcs.map((n) => ({ comment: `NPC·${n.name}`, content: n.content })), ...src.existing.entries.map((e) => ({ comment: e.comment, content: e.content }))],
                routes: src.routes.map((r) => `${r.name}：${r.info}`).join('\n'),
                greeting: src.existing.greetings[0] ?? '',
            },
            core: src.personas.map((p) => ({ name: p.name, text: '' })),
            shell: '',
            map: '',
            checks: {},
        };
        d.pick = -1;
        return d;
    }

    async function auCore(d) {
        if (!d.au) throw new Error('不是 AU 草稿');
        const raw = await run('auCore', d, { original: auOriginal(d) }, { key: 'au:core', prev: coreText(d) });
        remember(d, 'au:core', { core: d.au.core, shell: d.au.shell });
        const parsed = splitBlocks(raw);
        const byName = new Map(parsed.blocks.filter((b) => b.type === '内核').map((b) => [b.name, b.body]));
        d.au.core = d.au.core.map((c, i) => ({ name: c.name, text: byName.get(c.name) ?? [...byName.values()][i] ?? c.text }));
        d.au.shell = blockOf(parsed, '外壳') || d.au.shell;
        return d;
    }

    async function auMap(d) {
        if (!d.au) throw new Error('不是 AU 草稿');
        if (!str(d.idea)) throw new Error('先写 AU 设定');
        if (!coreText(d).replace(/[^\u4e00-\u9fff]/g, '')) throw new Error('先提取内核');
        const raw = await run('auMap', d, { core: coreText(d), shell: d.au.shell || '（没列）', original: auOriginal(d, 4000) }, { key: 'au:map', prev: d.au.map });
        remember(d, 'au:map', d.au.map);
        d.au.map = raw.trim();
        return d;
    }

    /** 内核一致性检查：逐条看 AU 人设有没有保住内核 */
    async function auCheck(d, name) {
        const p = d.personas.find((x) => x.name === name);
        if (!p?.text) throw new Error(`${name} 还没有 AU 人设`);
        const core = coreText(d, name);
        if (!core) throw new Error('没有这个角色的内核');
        const j = parseJSON(await run('auCheck', d, { name, core, persona: p.text }, { json: true }));
        const items = arr(j.items).map((x) => ({ core: str(x.core), verdict: ['保留', '偏离', '丢了'].includes(str(x.verdict)) ? str(x.verdict) : '偏离', where: str(x.where), fix: str(x.fix) })).filter((x) => x.core);
        d.au.checks[name] = { items, leftovers: arr(j.leftovers).map(str).filter(Boolean), fixed: false };
        return d.au.checks[name];
    }

    /** 按检查结果修：把偏离和残留写成修改意见，按意见改 */
    async function auFix(d, name) {
        const c = d.au?.checks?.[name];
        const bad = (c?.items ?? []).filter((x) => x.verdict !== '保留');
        if (!bad.length && !c?.leftovers?.length) return d;
        const fb = [
            ...bad.map((x) => `- 内核“${x.core}”${x.verdict}${x.where && x.where !== '没写到' ? `（「${x.where}」）` : ''}：${x.fix || '改回内核的样子'}`),
            ...(c.leftovers.length ? [`- 删掉或换掉原作世界的残留：${c.leftovers.join('、')}`] : []),
        ].join('\n');
        d.feedback ??= {};
        d.feedback[`persona:${name}`] = fb;
        await revise(d, `persona:${name}`);
        c.fixed = true;
        return d;
    }

    /** 读一张已有的卡进草稿 */
    function loadCard(card, worldData, worldName) {
        const d = cardToDraft(card, worldData, worldName);
        d.tags = sanitizeTags(d.tags.map((t) => t.name), L());
        return d;
    }

    /** 换回上一版：当前版本放回历史最前面，可以一直点着轮换 */
    function restore(d, key) {
        const list = d.history?.[key];
        const slot = slotOf(d, key);
        if (!list?.length || !slot) return false;
        const prev = list.pop();
        list.unshift(structuredClone(slot.get()));
        slot.set(prev);
        if (d.truncated) delete d.truncated[key];
        return true;
    }

    /** 回复里没有收尾标签 = 被截断了，自动续写一次 */
    async function complete(out, close, user, sys, st, temp) {
        if (!close || out.includes(close)) return { out, cut: false };
        progress('回复被截断了，自动续写…');
        const more = await deps.llm({
            system: sys,
            user: `${user}\n\n【你上一次的回答在这里断掉了。从断掉的地方直接接着写，不要重复已经写的内容，不要解释】\n……${out.slice(-1500)}`,
            stage: st,
            temperature: temp,
        });
        check();
        const joined = out + more.replace(/^\s*……/, '');
        return { out: joined, cut: !joined.includes(close) };
    }

    /**
     * @param {{stage?:string, system?:string, json?:boolean, key?:string, prev?:string, close?:string}} opt
     * key：这一块的名字（修改意见、上一版、截断提醒都按它记）；prev：上一版内容，有修改意见时一起发给 AI；close：收尾标签，用来判断有没有被截断
     */
    // ───── 文风 ─────
    const PERSONA_STEPS = new Set(['persona', 'backstory', 'destale']);
    const ALL_STYLE_STEPS = new Set(['world', 'npc', 'npcOne', 'routes', 'free', 'greeting', 'expand', 'custom']);
    /** 这一步要不要带文风：人设类步骤带；勾了“其他步骤也用”时世界观、NPC、路线、模块、开场白也带 */
    function styleOf(d, id, key = '') {
        const st = (S().styles ?? [])[Number(d.style) - 1];
        if (!str(st?.text)) return '';
        const personaish = PERSONA_STEPS.has(id) || String(key).startsWith('persona:');
        if (personaish || (d.styleAll && (ALL_STYLE_STEPS.has(id) || ['revise', 'localEdit'].includes(id)))) return st.text;
        return '';
    }

    /** 记下这次改了哪里（给“改了什么”看） */
    function noteChanges(d, key, before, after, how = '') {
        const hunks = diffLines(before, after);
        d.changes ??= {};
        d.changes[key] = { at: Date.now(), how, hunks: hunks.slice(0, 40), more: Math.max(0, hunks.length - 40) };
        return hunks.length;
    }

    async function run(id, d, extra = {}, { stage, system, json = false, key, prev, close, styleKey } = {}) {
        check();
        const info = STEP_INFO[id] ?? { name: id, stage: 'card', temp: 0.8 };
        progress(`${info.name}…`);
        let user = fill(promptOf(id), { ...baseVars(d), ...extra });
        user += ruleExtras(d, id);
        const style = styleOf(d, id, styleKey ?? key);
        if (style) user += `\n\n【文风】作者指定的文风如下。它只管用词和句子怎么写；内容、格式和上面的要求都不变，格式要求冲突时以格式为准。\n${style}`;
        const fb = key ? feedbackOf(d, key) : '';
        if (fb) {
            user += `\n\n【作者对上一版的修改意见，必须优先满足】\n${fb}`;
            if (str(prev)) user += `\n【上一版】（按意见改，没提到的好的部分可以保留）\n${clip(prev, 3000)}`;
        }
        const st = stage ?? info.stage;
        const sys = withBan(system ?? (st === 'greeting' ? SYSTEM_PROSE : SYSTEM_CARD), d);
        let out = await deps.llm({ system: sys, user, stage: st, temperature: info.temp });
        check();
        if (key) {
            const r = await complete(out, close, user, sys, st, info.temp);
            out = r.out;
            d.truncated ??= {};
            if (r.cut) d.truncated[key] = true; else delete d.truncated[key];
            if (fb) d.feedback[key] = '';
        }
        return json ? out : strip(out);
    }

    // ───── 0. 灵感 ─────
    async function inspire(d) {
        d.dice = rollDice(L(), d.diceLock ?? {});
        const dice = Object.entries(d.dice).map(([k, v]) => `${dimOf(L(), k)?.name ?? k}：${v}`).join('；');
        const j = parseJSON(await run('inspire', d, { dice }, { json: true }));
        d.inspire = arr(j.questions).slice(0, 4).map((q) => ({ q: str(q.q), options: arr(q.options).map(str).filter(Boolean).slice(0, 4), answer: '' }));
        return d;
    }

    /** 有脑洞时：针对脑洞问 3 个问题，答案在生成构想时一起带上 */
    async function ideaQA(d) {
        if (!str(d.idea)) throw new Error('先写一句话脑洞');
        const j = parseJSON(await run('ideaQA', d, {}, { json: true }));
        d.ideaQA = arr(j.questions).slice(0, 4).map((q) => ({ q: str(q.q), options: arr(q.options).map(str).filter(Boolean).slice(0, 4), answer: '' }));
        return d;
    }

    const ideaAnswers = (d) => {
        const list = (d.ideaQA ?? []).filter((q) => str(q.answer));
        return list.length ? `【作者补充】\n${list.map((q) => `${q.q}\n→ ${str(q.answer)}`).join('\n')}` : '';
    };

    function ideaFromInspire(d) {
        const dice = Object.values(d.dice ?? {}).join('、');
        const ans = (d.inspire ?? []).filter((q) => q.answer?.trim()).map((q) => q.answer.trim()).join('；');
        d.idea = [ans, dice ? `（参考标签：${dice}）` : ''].filter(Boolean).join(' ');
        return d.idea;
    }

    // ───── 1. 一句话构想 + 自动打标签 ─────
    function localTags(d) {
        const lib = L();
        const hits = matchTags(d.idea, lib);
        d.tagSrc ??= {};
        for (const h of hits) {
            const dim = dimOf(lib, h.dim);
            if (dim?.single && tagValue(d.tags, h.dim).length) continue; // 用户已经选了的单选维度不覆盖
            if (!d.tags.some((t) => t.dim === h.dim && t.name === h.name)) {
                d.tags = toggleTag(d.tags, lib, h.dim, h.name, true);
                d.tagSrc[`${h.dim}:${h.name}`] = 'local';
            }
        }
        return hits;
    }

    /** 作者已经写好的内容（填了一半再一键补全时，构想必须以它为准） */
    function writtenText(d) {
        const parts = [];
        const ps = (d.personas ?? []).filter((p) => str(p.text) || str(p.overview) || str(p.desc));
        if (ps.length) parts.push(`已写好的主要角色（lineup 必须用这些人，名字不改；可以再加人）：\n${ps.map((p) => `- ${p.name || '（还没起名）'}：${clip(str(p.overview) || str(p.desc) || str(p.text), 500)}`).join('\n')}`);
        if (str(d.world?.main)) parts.push(`已写好的世界观：\n${clip(d.world.main, 800)}`);
        const rs = (d.routes ?? []).filter((r) => str(r.info));
        if (rs.length) parts.push(`已写好的路线（routes 必须包含这些，名字不改）：\n${rs.map((r) => `- ${r.name}：${clip(r.info, 300)}`).join('\n')}`);
        if (str(d.tone)) parts.push(`已写好的基调：\n${clip(d.tone, 400)}`);
        return parts.length ? `【作者已经写好的内容】（最高优先级。三个构想都必须建立在这些内容上，不能换人、换设定；只补还没写的部分）\n${parts.join('\n')}` : '';
    }

    async function idea(d) {
        const lib = L();
        const hits = localTags(d);
        const j = parseJSON(await run('idea', d, {
            matched: hits.map((h) => h.name).join('、') || '（无）',
            tagLibrary: libraryText(lib),
            ideaAnswers: [ideaAnswers(d), writtenText(d)].filter(Boolean).join('\n'),
        }, { json: true, key: 'idea', prev: (d.concepts ?? []).map((c) => c.title).join('\n') }));
        remember(d, 'idea', { concepts: d.concepts, pick: d.pick });
        d.concepts = arr(j.concepts).slice(0, 3).map(normalizeConcept);
        if (!d.concepts.length) throw new Error('AI 没有给出构想');
        d.tagSrc ??= {};
        for (const t of sanitizeTags(arr(j.tags?.picked), lib)) {
            const dim = dimOf(lib, t.dim);
            if (dim?.single && tagValue(d.tags, t.dim).length) continue;
            if (!d.tags.some((x) => x.dim === t.dim && x.name === t.name)) {
                d.tags = toggleTag(d.tags, lib, t.dim, t.name, true);
                d.tagSrc[`${t.dim}:${t.name}`] = 'ai';
            }
        }
        for (const [dimName, name] of Object.entries(j.tags?.guessed ?? {})) {
            const dim = dimOf(lib, dimName) ?? lib.find((x) => x.name.includes(dimName));
            const t = findTag(lib, name, dim?.key);
            if (!t || tagValue(d.tags, t.dim).length) continue;
            d.tags = toggleTag(d.tags, lib, t.dim, t.name, true);
            d.tagSrc[`${t.dim}:${t.name}`] = 'guess';
        }
        d.ai = {
            novel: arr(j.tags?.novel).map((n) => ({ dim: (dimOf(lib, n?.dim) ?? lib.find((x) => x.name.includes(str(n?.dim))))?.key ?? 'plot', name: str(n?.name) })).filter((n) => n.name && !findTag(lib, n.name)).slice(0, 2),
            surprise: (() => {
                const s = j.tags?.surprise;
                const t = findTag(lib, str(s?.name), (dimOf(lib, s?.dim) ?? {}).key);
                return t ? { dim: t.dim, name: t.name, why: str(s?.why) } : null;
            })(),
        };
        d.fandom = str(j.fandom);
        d.check = arr(j.check).map(str).filter(Boolean);
        d.pick = -1;
        return d;
    }

    /** 选中一个构想：带出角色、路线、复杂度和标签 */
    function pickConcept(d, i) {
        const lib = L();
        const c = d.concepts[i];
        if (!c) return d;
        d.pick = i;
        const old = new Map((d.personas ?? []).map((p) => [p.name, p]));
        const mine = (p) => str(p.text) || str(p.desc) || p.added;
        // 作者自己写过的角色和路线不丢：构想里没有的也留着
        d.personas = [
            ...c.lineup.map((p) => old.get(p.name) ?? { name: p.name, keys: [], overview: '', text: '' }),
            ...(d.personas ?? []).filter((p) => mine(p) && !c.lineup.some((l) => l.name === p.name)),
        ];
        const oldRoutes = d.routes ?? [];
        d.routes = [
            ...c.routes.map((r) => ({ ...r, info: oldRoutes.find((x) => x.name === r.name)?.info ?? '' })),
            ...oldRoutes.filter((r) => str(r.info) && !c.routes.some((x) => x.name === r.name)),
        ];
        if (!d.name || d.nameAuto) {
            d.name = c.lineup.length === 1 ? c.lineup[0].name : c.title.slice(0, 20);
            d.nameAuto = true;
        }
        d.tagSrc ??= {};
        for (const t of sanitizeTags(c.tags, lib)) {
            const dim = dimOf(lib, t.dim);
            if (dim?.single && tagValue(d.tags, t.dim).length) continue;
            if (!d.tags.some((x) => x.dim === t.dim && x.name === t.name)) {
                d.tags = toggleTag(d.tags, lib, t.dim, t.name, true);
                d.tagSrc[`${t.dim}:${t.name}`] = 'ai';
            }
        }
        for (const p of c.lineup) {
            for (const t of sanitizeTags(p.archetype.map((a) => ({ dim: 'archetype', name: a })), lib)) {
                if (!d.tags.some((x) => x.dim === t.dim && x.name === t.name)) d.tags = toggleTag(d.tags, lib, t.dim, t.name, true);
            }
        }
        d.tags = toggleTag(d.tags, lib, 'complexity', c.complexity, true);
        return d;
    }

    // ───── 2. 人设 ─────
    async function qa(d) {
        const j = parseJSON(await run('qa', d, {}, { json: true }));
        const names = (d.personas ?? []).map((p) => p.name);
        d.qa = {
            chars: arr(j.chars).map((c, i) => ({
                name: names.includes(str(c.name)) ? str(c.name) : (names[i] ?? str(c.name)),
                questions: arr(c.questions).slice(0, 4).map((q) => ({ q: str(q.q), options: arr(q.options).map(str).filter(Boolean).slice(0, 4), answer: '' })),
            })),
        };
        return d;
    }

    /** 写人设。可以传名字或序号；名字空着时让 AI 起名（新加的角色） */
    async function persona(d, nameOrIndex) {
        const p = typeof nameOrIndex === 'number' ? d.personas[nameOrIndex] : d.personas.find((x) => x.name === nameOrIndex);
        if (!p) throw new Error(`没有角色 ${nameOrIndex}`);
        const NEW = '〔新角色〕';
        const unnamed = !str(p.name);
        const name = unnamed ? NEW : str(p.name);
        const others = d.personas.filter((x) => x !== p && str(x.name));
        const lineup = concept(d)?.lineup ?? [];
        const otherText = others.length
            ? `【同卡的其他主要角色】\n${others.map((o) => `${o.name}：${o.overview || lineup.find((l) => l.name === o.name)?.identity || ''}`).join('\n')}`
            : '';
        const np = others.length || modeOf(d) === 'multi';
        const npRule = np ? `- 这张卡有多个主要角色。${name} 要占一个和其他人不同的张力位置（权力压制、旧情未了、立场敌对……），他对〔user〕的态度、他想要的东西、他的矛盾轴都不能和其他人重复。` : '';
        const answers = (d.qa?.chars ?? []).filter((c) => c.name === name).flatMap((c) => c.questions)
            .filter((q) => q.answer?.trim()).map((q) => `${q.q}\n→ ${q.answer.trim()}`).join('\n');
        const ident = (concept(d)?.lineup ?? []).find((l) => l.name === name)?.identity;
        const brief = [
            str(p.desc) ? `【作者对这个角色的设想】（必须落实）\n${str(p.desc)}` : '',
            ident ? `【构想里的身份】${ident}` : '',
            unnamed ? `【名字】还没起。你来起一个不俗套、合这张卡的名字，在最前面单独输出一块：\n<<<名字>>>\n名字\n后面所有写着“${NEW}”的地方都换成这个名字。` : '',
            !ident && !str(p.desc) && !p.text && (d.existing || others.length) ? '【这是新加进来的角色】根据这张卡已有的内容，补一个卡里缺的、能和已有角色形成张力的人。' : '',
        ].filter(Boolean).join('\n');
        const raw = await run('persona', d, {
            name,
            brief,
            others: otherText,
            npRule,
            answers: answers || answersText(d),
            template: fill(rules(d)['人设模板'] || PERSONA_TEMPLATE, { name }),
        }, { key: `persona:${name}`, prev: p.text, close: unnamed ? undefined : `</${name}>` });
        const parsed = splitBlocks(raw);
        let real = name;
        if (unnamed) {
            real = str(blockOf(parsed, '名字')).split('\n')[0].replace(/[<>《》「」"“”]/g, '').trim() || '新角色';
            for (let k = 2; d.personas.some((x) => x !== p && x.name === real); k++) real = `${real}${k}`;
        }
        remember(d, `persona:${real}`, { overview: p.overview, text: p.text });
        const body = blockOf(parsed, '人设') || parsed.lead || raw;
        const fix = (t) => String(t ?? '').split(NEW).join(real);
        p.name = real;
        p.overview = fix(blockOf(parsed, '概要')) || p.overview;
        p.text = extractTagged(fix(body), real);
        if (!p.keys?.length) p.keys = [];
        return d;
    }

    /** 单独展开经历：一次只写经历，写完合并回人设的 life_story */
    async function backstory(d, name) {
        const p = d.personas.find((x) => x.name === name);
        if (!p?.text?.trim()) throw new Error(`${name} 还没有人设`);
        const key = `persona:${name}`;
        const answers = (d.qa?.chars ?? []).filter((c) => c.name === name).flatMap((c) => c.questions)
            .filter((q) => q.answer?.trim()).map((q) => `${q.q}\n→ ${q.answer.trim()}`).join('\n');
        const raw = await run('backstory', d, { name, persona: p.text, answers: answers || answersText(d), count: S().backstoryCount || '4–7' }, { key: `backstory:${name}`, prev: p.text });
        const block = raw.slice(Math.max(0, raw.search(/life_story\s*:/)));
        if (!/life_story\s*:/.test(block)) throw new Error('AI 没按格式写经历，再试一次');
        remember(d, key, { overview: p.overview, text: p.text });
        const before = p.text;
        p.text = mergeLifeStory(p.text, block);
        noteChanges(d, key, before, p.text, '展开经历');
        return lifeStoryStats(p.text);
    }

    // ───── 3. 世界观 ─────
    async function world(d) {
        const complexity = tagValue(d.tags, 'complexity')[0] ?? concept(d)?.complexity ?? '简单';
        const pistol = isPistol(d);
        const fandom = tagValue(d.tags, 'source').includes('同人') && d.fandom ? `【同人】${d.fandom}` : '';
        const raw = await run('world', d, {
            complexity,
            fandom,
            zeroRule: pistol ? '- 手枪卡：不用零度写作，简洁写清场景即可。' : rules(d)['零度写作'],
        }, { key: 'world', prev: d.world?.main, close: '</世界观>' });
        remember(d, 'world', d.world);
        const parsed = splitBlocks(raw);
        d.world = {
            main: parsed.lead,
            extra: parsed.blocks.filter((b) => b.body).map((b) => ({ name: b.name || b.type, keys: b.keys, content: b.body })),
        };
        if (!d.world.main && d.world.extra.length) d.world.main = d.world.extra.shift().content;
        return d;
    }

    // ───── 4. NPC ─────
    async function npc(d) {
        let count = concept(d)?.npcs ?? 2;
        if (modeOf(d) === 'world') count = Math.max(Number(count) || 0, 6); // 世界卡：人物都在 NPC 库里
        const raw = await run('npc', d, { count: count || 2 }, { key: 'npc', prev: (d.npcs ?? []).map((n) => n.content).join('\n') });
        remember(d, 'npc', d.npcs);
        const parsed = splitBlocks(raw);
        const list = parsed.blocks.filter((b) => b.body).map((b) => ({ name: b.name || '未命名', keys: b.keys, content: b.body }));
        if (!list.length && parsed.lead) list.push({ name: 'NPC', keys: [], content: parsed.lead });
        d.npcs = list;
        return d;
    }

    /** 多人卡：主要角色之间的关系网、修罗场、出场规则（常驻在人设后面） */
    async function relations(d) {
        if ((d.personas ?? []).filter((p) => str(p.name)).length < 2) throw new Error('至少要有两个主要角色');
        const raw = await run('relations', d, {}, { key: 'relations', prev: d.relations, close: '</角色关系>' });
        remember(d, 'relations', d.relations ?? '');
        const before = d.relations ?? '';
        d.relations = raw.trim();
        if (str(before)) noteChanges(d, 'relations', before, d.relations, '重写角色关系');
        return d;
    }

    /** 只写（或重写）第 i 个 NPC；名字、作者的设想可以先填，空着让 AI 想 */
    async function npcOne(d, i) {
        const n = d.npcs[i];
        if (!n) throw new Error('没有这个 NPC');
        const others = d.npcs.filter((x, k) => k !== i && str(x.content));
        const raw = await run('npcOne', d, {
            name: str(n.name) || '（你来起）',
            desc: str(n.desc) || '（没写，你来想一个这张卡缺的）',
            otherNpcs: others.map((x) => `${x.name}：${clip(x.content, 200)}`).join('\n') || '（还没有）',
        }, { styleKey: 'npc' });
        const parsed = splitBlocks(raw);
        const b = parsed.blocks.find((x) => x.body) ?? (parsed.lead ? { name: '', keys: [], body: parsed.lead } : null);
        if (!b) throw new Error('AI 没按格式写，再试一次');
        remember(d, 'npc', d.npcs);
        const before = n.content ?? '';
        if (!str(n.name) && b.name) n.name = b.name;
        n.keys = [...new Set([...(n.keys ?? []), ...(b.keys ?? [])].map((k) => str(k)).filter((k) => k && k !== n.name))];
        n.content = b.body;
        if (str(before)) noteChanges(d, 'npc', before, n.content, `重写 ${n.name}`);
        return n;
    }

    // ───── 5. 路线 ─────
    /** 玩家信息和关系指导按每个主要角色的名字分开写（多人卡每个人都要写到） */
    function routeFieldVars(d) {
        const names = (d.personas ?? []).map((p) => str(p.name)).filter(Boolean);
        if (!names.length) {
            return {
                charNames: '这个世界里的关键人物',
                relationFields: '〔user〕在这个世界的处境：\n〔user〕和关键人物的关系：（写名字）',
                guideFields: '关键人物各自对〔user〕的态度：（写名字）',
            };
        }
        return {
            charNames: names.join('、'),
            relationFields: names.map((n) => `〔user〕和${n}的关系：\n〔user〕和${n}的过去：`).join('\n'),
            guideFields: names.map((n) => `${n}：`).join('\n'),
        };
    }

    /** 写路线信息。only = 只写第几条（单独写 / 重写一条）；不传就写空着的，全写好了就全部重写 */
    async function routes(d, only) {
        if (!d.routes?.length) d.routes = [{ name: '主线', user: '', period: '', info: '' }];
        const empty = d.routes.filter((r) => !str(r.info));
        const targets = Number.isInteger(only) ? [d.routes[only]].filter(Boolean) : (empty.length ? empty : d.routes);
        if (!targets.length) throw new Error('没有这条路线');
        const before = targets.map((r) => r.info ?? '');
        const others = d.routes.filter((r) => !targets.includes(r) && str(r.info));
        const raw = await run('routes', d, {
            routes: targets.map((r, i) => `${i + 1}. ${r.name}｜〔user〕身份：${r.user || '未定'}｜时期：${r.period || '未定'}${str(r.desc) ? `\n   作者定的主题（必须按这个写）：${str(r.desc)}` : ''}${Number.isInteger(only) && str(r.info) ? `\n   上一版：${clip(r.info, 600)}` : ''}`).join('\n'),
            otherRoutes: others.length ? `【已有的路线】（不用重写，新路线要和它们区分开）\n${others.map((r) => `${r.name}：${clip(r.info, 300)}`).join('\n')}` : '',
            ...routeFieldVars(d),
        }, { key: 'routes', prev: targets.map((r) => r.info).join('\n') });
        remember(d, 'routes', d.routes.map((r) => r.info));
        const parsed = splitBlocks(raw);
        const blocks = parsed.blocks.filter((b) => b.body);
        if (!blocks.length && parsed.lead) blocks.push({ name: targets[0].name, body: parsed.lead });
        const used = new Set();
        for (const b of blocks) {
            let r = targets.find((x) => !used.has(x) && (x.name === b.name || (b.name && (x.name.includes(b.name) || b.name.includes(x.name)))));
            r ??= targets.find((x) => !used.has(x));
            if (!r) continue; // AI 多写的路线不要，路线只由作者加
            used.add(r);
            r.info = b.body;
        }
        if (Number.isInteger(only) && str(before[0])) noteChanges(d, 'routes', before[0], targets[0].info, `重写路线 ${targets[0].name}`);
        return d;
    }

    // ───── 6. 基调与规则 ─────
    async function tone(d) {
        const raw = await run('tone', d, { cardType: tagValue(d.tags, 'cardType').join('、') || '单人卡' }, { key: 'tone', prev: d.tone, close: '</创作文体>' });
        remember(d, 'tone', d.tone);
        d.tone = extractTagged(raw, '创作文体');
        return d;
    }

    async function free(d, i) {
        const f = d.free[i];
        if (!f?.name?.trim()) throw new Error('先给模块起个名字');
        const raw = await run('free', d, { name: f.name.trim(), desc: f.desc || '（无）' }, { key: `free:${f.name.trim()}`, prev: f.content, close: `</${f.name.trim()}>` });
        remember(d, `free:${f.name.trim()}`, f.content);
        f.content = extractTagged(raw, f.name.trim());
        return d;
    }

    /** 用户自己加的步骤：模板里的变量同样可用，产出写进一个自由模块 */
    async function custom(d, step) {
        check();
        const name = str(step.name) || '我的步骤';
        progress(`${name}…`);
        const key = `free:${name}`;
        let f = d.free.find((x) => x.fromStep === step.id);
        let user = fill(step.template, { ...baseVars(d), name });
        const fb = feedbackOf(d, key);
        if (fb) {
            user += `\n\n【作者对上一版的修改意见，必须优先满足】\n${fb}`;
            if (str(f?.content)) user += `\n【上一版】\n${clip(f.content, 3000)}`;
        }
        const st = step.stage || 'card';
        const out = strip(await deps.llm({ system: withBan(st === 'greeting' ? SYSTEM_PROSE : SYSTEM_CARD, d), user, stage: st, temperature: 0.8 }));
        check();
        if (fb) d.feedback[key] = '';
        d.custom ??= {};
        d.custom[step.id] = out;
        if (step.output !== 'none') {
            if (!f) { f = { name, desc: '', content: '', light: step.light || 'blue', keys: step.keys ?? [], position: step.position || 'after', fromStep: step.id }; d.free.push(f); }
            remember(d, key, f.content);
            f.name = name;
            f.content = out;
        }
        return d;
    }

    // ───── 7. 开场白 ─────
    async function greetings(d, ri, n = S().greetingCount || 2) {
        const r = routeOf(d, ri);
        const raw = await run('greeting', d, {
            route: r.label ?? r.name,
            n,
            length: S().greetingLength || '600–900',
            routeInfo: r.info || `${r.name}｜〔user〕身份：${r.user || '未定'}｜时期：${r.period || '未定'}`,
            personas: clip((d.personas ?? []).map((p) => p.text).join('\n\n'), 5000),
        }, { key: `greet:${r.name}`, prev: (d.greetings ?? []).filter((g) => g.route === r.name).map((g) => g.text).join('\n\n') });
        remember(d, `greet:${r.name}`, (d.greetings ?? []).filter((g) => g.route === r.name).map((g) => g.text));
        const parsed = splitBlocks(raw);
        let texts = parsed.blocks.filter((b) => b.type === '开场白' && b.body).map((b) => b.body);
        if (!texts.length && parsed.lead) texts = [parsed.lead];
        d.greetings = (d.greetings ?? []).filter((g) => g.route !== r.name);
        d.greetings.push(...texts.map((text) => ({ route: r.name, text })));
        return d;
    }

    // 先想梗，再扩写
    /** 第 ri 条路线；ri = -1 或者还没有路线时是“不分路线” */
    function routeOf(d, ri) {
        const r = Number(ri) >= 0 ? d.routes[Number(ri)] : null;
        if (r) return r;
        const names = (d.routes ?? []).map((x) => x.name).filter(Boolean);
        return {
            name: '', label: '不分路线',
            info: `不分路线：这个开场白不绑定某一条路线。按人设、世界观和基调写，〔user〕的身份可以在开场白里自然交代，也可以沿用卡里已有的设定。${names.length ? `（这张卡的路线有：${names.join('、')}，这个开场白不属于其中任何一条）` : ''}`,
        };
    }

    const routeVars = (d, r) => ({
        route: r.label ?? r.name,
        routeInfo: r.info || `${r.name}｜〔user〕身份：${r.user || '未定'}｜时期：${r.period || '未定'}`,
        length: S().greetingLength || '600–900',
        personas: clip((d.personas ?? []).map((p) => p.text).join('\n\n'), 5000),
    });

    async function hooks(d, ri, n = 5) {
        const r = routeOf(d, ri);
        d.hooks ??= {};
        const list = (d.hooks[r.name] ??= []);
        const j = parseJSON(await run('hooks', d, {
            ...routeVars(d, r),
            n,
            existing: list.map((h) => `- ${h.text}`).join('\n') || '（无）',
        }, { json: true, key: `hooks:${r.name}` }));
        const fresh = arr(j.hooks).map(str).filter(Boolean).map((t) => strip(t));
        // 没勾选、没扩写过的旧梗换掉，勾了的和自己写的留着
        d.hooks[r.name] = [...list.filter((h) => h.on || h.mine || h.used), ...fresh.map((text) => ({ text, on: false }))];
        return d;
    }

    async function expand(d, ri) {
        const r = routeOf(d, ri);
        const picked = (d.hooks?.[r.name] ?? []).filter((h) => h.on && str(h.text));
        if (!picked.length) throw new Error('先勾选要扩写的梗，或者自己写一个');
        const raw = await run('expand', d, {
            ...routeVars(d, r),
            hooks: picked.map((h, i) => `${i + 1}. ${h.text}`).join('\n'),
        }, { key: `greet:${r.name}` });
        const parsed = splitBlocks(raw);
        let texts = parsed.blocks.filter((b) => b.type === '开场白' && b.body).map((b) => b.body);
        if (!texts.length && parsed.lead) texts = [parsed.lead];
        remember(d, `greet:${r.name}`, (d.greetings ?? []).filter((g) => g.route === r.name).map((g) => g.text));
        d.greetings ??= [];
        d.greetings.push(...texts.map((text) => ({ route: r.name, text })));
        for (const h of picked) { h.on = false; h.used = true; }
        return texts.length;
    }

    // ───── 局部重写 ─────
    const getAt = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
    const setAt = (o, path, v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((x, k) => (x[k] ??= {}), o)[last] = v; };

    /**
     * 只改选中的一段：把选中的部分用【【 】】标出来，AI 只交回这一段，前后原样拼回去。
     * @param {{path:string, start:number, end:number, instruction?:string, key?:string, label?:string}} o
     */
    async function localEdit(d, { path, start, end, instruction = '', key = '', label = '' }) {
        const text = String(getAt(d, path) ?? '');
        if (!(end > start) || end > text.length) throw new Error('先在框里选中要改的那段');
        const sel = text.slice(start, end);
        if (!str(sel)) throw new Error('选中的是空白');
        const W = 2500;
        const head = text.slice(Math.max(0, start - W), start);
        const tail = text.slice(end, end + W);
        const context = `${start > W ? '……' : ''}${head}【【${sel}】】${tail}${end + W < text.length ? '……' : ''}`;
        const out = await run('localEdit', d, {
            label: label || path,
            instruction: str(instruction) || '重写这一段：意思和信息保留，写得更具体、更像这个角色自己，去掉套话和空泛的形容。',
            context,
        }, { styleKey: key });
        let rep = String(out).replace(/【【|】】/g, '').trim();
        // 保留选中部分原来的缩进、列表符号、YAML 键名和结尾换行（AI 常把它们丢掉）
        const pre = sel.match(/^\s*(?:[-*]\s+)?(?:[A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]{0,20}:\s+)?/)[0];
        const lead = sel.match(/^\s*/)[0];
        const trail = sel.match(/\s*$/)[0];
        rep = (pre.trim() && !rep.startsWith(pre.trim()) ? pre : lead) + rep + trail;
        if (key) {
            const slot = slotOf(d, key);
            if (slot) remember(d, key, structuredClone(slot.get()));
        }
        setAt(d, path, text.slice(0, start) + rep + text.slice(end));
        if (key) {
            d.changes ??= {};
            d.changes[key] = { at: Date.now(), how: `局部重写${str(instruction) ? `：${str(instruction).slice(0, 40)}` : ''}`, hunks: [{ before: sel.trim(), after: rep.trim() }], more: 0 };
        }
        return { before: sel, after: rep };
    }

    // ───── 试玩 ─────
    const charName = (d) => str(d.existing?.name) || str(d.personas?.[0]?.name) || str(d.name) || '角色';

    /** 可以从哪些开场白开始：原卡的在前，新写的在后 */
    function playGreetings(d) {
        const out = [];
        const origRoute = d.routes.find((r) => r.orig)?.name ?? d.routes[0]?.name ?? '';
        (d.existing?.greetings ?? []).forEach((t, i) => { if (str(t)) out.push({ label: `原卡·${i === 0 ? '主开场白' : `开场白 ${i + 1}`}`, text: t, route: origRoute }); });
        const counts = {};
        for (const g of orderedGreetings(d)) {
            counts[g.route] = (counts[g.route] ?? 0) + 1;
            out.push({ label: `${g.route || '主线'} · ${counts[g.route]}`, text: g.text, route: g.route });
        }
        return out;
    }

    /** 试玩时把 {{char}}、<user> 换成名字（user 名字空着就保持 <user>） */
    function playSub(d, text) {
        const p = d.play ?? {};
        let t = String(text ?? '').replace(/\{\{char\}\}|〔char〕/gi, charName(d));
        const u = str(p.userName);
        if (u) {
            const tok = str(S().userToken) || '<user>';
            t = t.split(tok).join(u).replace(/\{\{user\}\}|〔user〕|<user>/gi, u);
        }
        return t;
    }

    function playTranscript(d, max = 8000) {
        const p = d.play;
        const t = (p?.messages ?? []).map((m, i) => `[第 ${i + 1} 条] ${m.role === 'char' ? charName(d) : '〔user〕'}：${m.text}`).join('\n\n');
        return t.length > max ? `……（前面省略）\n${t.slice(-max)}` : t;
    }

    const playRoute = (d) => {
        const i = d.routes.findIndex((r) => r.name === d.play?.route);
        return i < 0 ? 0 : i;
    };

    /** 这一轮会发出去的设定（蓝灯 + 当前路线 + 最近几条消息里提到的绿灯） */
    function playContext(d) {
        const scan = (d.play?.messages ?? []).slice(-5).map((m) => m.text).join('\n');
        return sentContext(d, { personaPlace: S().personaPlace, activeRoute: playRoute(d), scan });
    }

    function playStart(d, gi) {
        const list = playGreetings(d);
        const g = list[gi] ?? list[0];
        if (!g) throw new Error('还没有开场白，先去开场白页写一个');
        d.play = { ...(d.play ?? {}), greet: list.indexOf(g), route: g.route, messages: [{ role: 'char', text: g.text }], review: null, input: '' };
        return d.play;
    }

    async function playChar(d) {
        const p = d.play;
        if (!p?.messages?.length) throw new Error('先选一个开场白，点“开始”');
        if (p.messages.at(-1).role !== 'user') throw new Error('先写一句 user 的话');
        check();
        const c = playContext(d);
        p.sent = [...c.before, ...c.card, ...c.after].map((x) => x.label);
        const system = playSub(d, fill(promptOf('playChar'), { ...baseVars(d), char: charName(d), card: contextText(c), length: S().playLength || 300 }) + ruleExtras(d, 'playChar'));
        const messages = p.messages.map((m) => ({ role: m.role === 'char' ? 'assistant' : 'user', content: playSub(d, m.text) }));
        progress(`${STEP_INFO.playChar.name}…`);
        const out = await deps.llm({ system, messages, stage: STEP_INFO.playChar.stage, temperature: STEP_INFO.playChar.temp });
        check();
        p.messages.push({ role: 'char', text: str(out) });
        p.review = null;
        return p;
    }

    const PLAY_STYLES = {
        普通: '普通玩家：顺着剧情走，偶尔提问，给角色留空间。',
        唱反调: '爱唱反调的玩家：拒绝、怀疑、刁难，试探角色的底线，看角色会不会崩。',
        话少: '话很少的玩家：只给很短的回应或一个动作，看角色能不能自己把剧情推下去。',
        乱来: '不按套路的玩家：做出卡里没预料到的事（突然离开、提起无关的事、做奇怪的决定），看角色和世界怎么接。',
    };

    /** AI 扮 user 写一条；send=false 时只放进输入框让作者改 */
    async function playUser(d, { send = true } = {}) {
        const p = d.play;
        if (!p?.messages?.length) throw new Error('先选一个开场白，点“开始”');
        const r = d.routes[playRoute(d)];
        const out = await run('playUser', d, {
            style: PLAY_STYLES[p.style] ?? PLAY_STYLES.普通,
            routeInfo: r ? (r.info || `${r.name}｜〔user〕身份：${r.user || '未定'}`) : '（没有路线信息）',
            transcript: playTranscript(d, 6000),
        }, { system: '你在帮作者测试角色卡，扮演玩家。只输出要求的内容。', json: true });
        const text = str(out).replace(/^〔user〕[：:]\s*/, '');
        if (send) { p.messages.push({ role: 'user', text }); p.input = ''; } else p.input = text;
        return text;
    }

    async function playAuto(d, rounds = 3) {
        const p = d.play;
        if (!p?.messages?.length) throw new Error('先选一个开场白，点“开始”');
        const n = Math.max(1, Math.min(10, Number(rounds) || 3));
        for (let i = 0; i < n; i++) {
            check();
            progress(`试玩 第 ${i + 1}/${n} 轮：AI 扮 user…`);
            if (p.messages.at(-1).role !== 'user') await playUser(d);
            progress(`试玩 第 ${i + 1}/${n} 轮：角色回复…`);
            await playChar(d);
        }
        return n;
    }

    async function playRedo(d) {
        const p = d.play;
        if (!p || p.messages.length < 2 || p.messages.at(-1).role !== 'char') throw new Error('最后一条不是角色的回复');
        p.messages.pop();
        return playChar(d);
    }

    async function playReview(d) {
        const p = d.play;
        if (!p || p.messages.length < 3) throw new Error('至少跑一两轮再点评');
        const r = d.routes[playRoute(d)];
        const j = parseJSON(await run('playReview', d, {
            routeInfo: r ? (r.info || r.name) : '（没有路线信息）',
            transcript: playTranscript(d),
        }, { json: true }));
        const parts = ['persona', 'world', 'npc', 'routes', 'tone', 'greet'];
        p.review = {
            score: Number(j.score) || null,
            good: arr(j.good).map(str).filter(Boolean),
            issues: arr(j.issues).map((x) => ({ where: str(x.where), problem: str(x.problem), part: parts.includes(str(x.part)) ? str(x.part) : 'persona', name: str(x.name), fix: str(x.fix) })).filter((x) => x.problem || x.fix),
        };
        return p.review;
    }

    /** 点评里的一条问题 → 去哪一页、意见写进哪一块 */
    function reviewTarget(d, issue) {
        const persona = d.personas.find((x) => issue.name && (x.name === issue.name || issue.name.includes(x.name))) ?? d.personas[0];
        const route = d.play?.route ?? d.routes[0]?.name ?? '';
        switch (issue.part) {
            case 'world': return { page: 'world', key: 'world' };
            case 'npc': return { page: 'npc', key: 'npc' };
            case 'routes': return { page: 'routes', key: 'routes' };
            case 'tone': return { page: 'tone', key: 'tone' };
            case 'greet': return { page: 'greet', key: `greet:${route}` };
            default: return { page: 'persona', key: `persona:${persona?.name ?? ''}` };
        }
    }

    // ───── 8. 质检 ─────
    async function predict(d, name) {
        const p = d.personas.find((x) => x.name === name);
        if (!p?.text) throw new Error(`${name} 还没有人设`);
        const arch = concept(d)?.lineup?.find((l) => l.name === name)?.archetype?.join('、') || tagValue(d.tags, 'archetype').join('、') || '主角';
        const tags = ['era', 'relation', 'flavor', 'cp'].map((k) => tagValue(d.tags, k).join('、')).filter(Boolean).join('；');
        // 第一次：只给标签，让 AI 猜刻板写法（看不到人设）
        const j = parseJSON(await run('predict', d, { archetype: arch, tags }, { json: true }));
        const predicted = { scenes: arr(j.scenes), traits: arr(j.traits).map(str) };
        const stereotypes = [
            ...predicted.scenes.flatMap((sc) => [sc.behavior && `${sc.scene}：${sc.behavior}`, sc.line && `${sc.scene}时说：${sc.line}`]),
            ...predicted.traits,
        ].filter(Boolean).map((x) => `- ${x}`).join('\n');
        // 第二次：按意思比对，不看字面
        let judged = [];
        try {
            const k = parseJSON(await run('judge', d, { name, stereotypes, persona: p.text }, { json: true }));
            judged = arr(k.overlaps).filter((o) => str(o?.card)).slice(0, 8)
                .map((o) => ({ from: 'AI 比对', text: [str(o.stereotype), str(o.why)].filter(Boolean).join('：'), card: str(o.card), score: 1 }));
        } catch (e) {
            if (aborted()) throw e;
        }
        const local = predictOverlap(predicted, p.text, S().predictThreshold ?? 0.42);
        const overlaps = [...judged, ...local.filter((l) => !judged.some((x) => x.card.includes(l.card.slice(0, 12)) || l.card.includes(x.card.slice(0, 12))))];
        d.predict ??= {};
        d.predict[name] = { predicted, overlaps, rewritten: false };
        return d.predict[name];
    }

    async function destale(d, name) {
        const p = d.personas.find((x) => x.name === name);
        const ov = d.predict?.[name]?.overlaps ?? [];
        if (!p || !ov.length) return d;
        const overlaps = ov.map((o) => `- 卡里：「${o.card}」\n  刻板写法（${o.from}）：「${o.text}」`).join('\n');
        const raw = await run('destale', d, { name, overlaps, persona: p.text });
        const before = p.text;
        remember(d, `persona:${name}`, { overview: p.overview, text: before });
        p.text = extractTagged(raw, name);
        const n = noteChanges(d, `persona:${name}`, before, p.text, `重写撞车的 ${ov.length} 处`);
        d.predict[name].fixed = ov.map((o) => ({ card: o.card, text: o.text }));
        d.predict[name].overlaps = [];
        d.predict[name].rewritten = true;
        return n;
    }

    /** 本地扫描整张卡 */
    function localCheck(d) {
        const names = (d.personas ?? []).map((p) => p.name).concat((d.npcs ?? []).map((n) => n.name));
        const pistol = isPistol(d);
        const sections = [];
        const ban = banned(d);
        const add = (label, text, kind) => {
            const issues = scanCard(text, kind, { names, pistol });
            for (const w of findWords(text, ban)) issues.push({ type: 'cliche', level: 'warn', label: '禁用词', match: w });
            if (issues.length) sections.push({ label, issues });
        };
        add('基调与规则', d.tone, 'tone');
        add('世界观', d.world?.main, 'world');
        for (const e of d.world?.extra ?? []) add(`世界观·${e.name}`, e.content, 'world');
        for (const p of d.personas ?? []) add(`人设·${p.name}`, `${p.overview}\n${p.text}`, 'persona');
        for (const n of d.npcs ?? []) add(`NPC·${n.name}`, n.content, 'npc');
        for (const r of d.routes ?? []) add(`路线·${r.name}`, r.info, 'route');
        orderedGreetings(d).forEach((g, i) => add(`开场白 ${i + 1}（${g.route}）`, g.text, 'greeting'));
        for (const f of d.free ?? []) add(`模块·${f.name}`, f.content, 'free');
        if (d.intro?.text) add('简介', d.intro.text, 'intro');
        const cross = (d.personas ?? []).length > 1
            ? crossCompare(Object.fromEntries(d.personas.filter((p) => p.text).map((p) => [p.name, p.text])))
            : [];
        return { sections, cross };
    }

    /** 列出可以交给八股清理的文本位置 */
    /**
     * 卡里所有能做八股检查的文字。page 是它所在的页面。
     * all=true 时把开场白的梗、AU 内核、简介也算上（只在单页检查里用，一键八股清理不碰它们）
     */
    function textSlots(d, { all = false } = {}) {
        const slots = [];
        const slot = (label, kind, page, get, set, more = {}) => { if (str(get())) slots.push({ label, kind, page, get, set, ...more }); };
        // 规则清单本来就列着禁用词，八股清理跳过
        slot('基调与规则', '世界书条目', 'tone', () => d.tone, (v) => { d.tone = v; }, { rules: true });
        slot('世界观', '世界书条目', 'world', () => d.world.main, (v) => { d.world.main = v; });
        d.world.extra.forEach((e) => slot(`世界观·${e.name}`, '世界书条目', 'world', () => e.content, (v) => { e.content = v; }));
        d.personas.forEach((p) => {
            slot(`人设概要·${p.name}`, '人设', 'persona', () => p.overview, (v) => { p.overview = v; });
            slot(`人设·${p.name}`, '人设', 'persona', () => p.text, (v) => { p.text = v; });
        });
        slot('角色关系', '世界书条目', 'persona', () => d.relations, (v) => { d.relations = v; });
        d.npcs.forEach((n) => slot(`NPC·${n.name}`, '世界书条目', 'npc', () => n.content, (v) => { n.content = v; }));
        d.routes.forEach((r) => slot(`路线·${r.name}`, '世界书条目', 'routes', () => r.info, (v) => { r.info = v; }));
        d.free.forEach((f) => slot(`模块·${f.name}`, '世界书条目', f.fromStep ? `step:${f.fromStep}` : 'tone', () => f.content, (v) => { f.content = v; }));
        if (all) {
            for (const [route, list] of Object.entries(d.hooks ?? {})) {
                (list ?? []).forEach((h, i) => slot(`梗·${route} ${i + 1}`, '开场白的梗', 'greet', () => h.text, (v) => { h.text = v; }));
            }
        }
        (d.greetings ?? []).forEach((g, i) => slot(`开场白 ${i + 1}`, '开场白', 'greet', () => g.text, (v) => { g.text = v; }));
        if (d.existing) {
            for (const [k, label] of [['description', '角色描述'], ['personality', '性格'], ['scenario', '场景']]) {
                slot(`原卡·${label}`, '角色卡', 'existing', () => d.existing.fields[k], (v) => { d.existing.fields[k] = v; });
            }
            d.existing.entries.forEach((e) => slot(`原卡·${e.comment}`, '世界书条目', 'existing', () => e.content, (v) => { e.content = v; }));
            d.existing.greetings.forEach((g, i) => slot(`原卡·开场白 ${i + 1}`, '开场白', 'existing', () => d.existing.greetings[i], (v) => { d.existing.greetings[i] = v; }));
        }
        if (all && d.play?.messages) {
            // 试玩的回复只查不改：八股多半来自人设和开场白，要去那边改
            d.play.messages.forEach((m, i) => { if (i > 0 && m.role === 'char') slot(`试玩·第 ${i + 1} 条`, '对话', 'play', () => m.text, (v) => { m.text = v; }, { scanOnly: true }); });
        }
        if (all && d.au) {
            (d.au.core ?? []).forEach((c) => slot(`AU 内核·${c.name}`, '人设', 'au', () => c.text, (v) => { c.text = v; }));
        }
        if (all && d.intro) {
            const parts = d.intro.parts ?? {};
            if (Object.values(parts).some((x) => str(x))) {
                for (const k of Object.keys(parts)) slot(`简介·${k}`, '角色卡简介', 'intro', () => parts[k], (v) => { parts[k] = v; }, { introPart: true });
            } else {
                slot('简介', '角色卡简介', 'intro', () => d.intro.text, (v) => { d.intro.text = v; });
            }
        }
        return slots;
    }

    // ───── 9. 简介 ─────
    async function intro(d) {
        const s = S();
        const g = orderedGreetings(d)[0];
        const raw = await run('intro', d, {
            introTags: tagsText(d.tags, L()),
            greetingSample: g ? clip(g.text, 600) : '（无）',
        }, { key: 'intro', prev: d.intro?.text });
        remember(d, 'intro', d.intro);
        const parsed = splitBlocks(raw);
        const parts = Object.fromEntries(parsed.blocks.map((b) => [b.type, b.body]));
        const titles = parseTitles(parts['标题']);
        d.intro = { titles, pick: 0, parts, text: '' };
        d.intro.text = composeIntroFor(d, s);
        return d;
    }

    /** 当前简介风格：0 = 默认，其余是设置里存的 */
    const introStyle = (s = S()) => {
        const i = Number(s.introStyle ?? 0);
        return i > 0 ? s.introStyles?.[i - 1]?.tpl : DEFAULT_INTRO_STYLE;
    };

    /** 简介致谢：写卡工坊一定有；人设模板没改过（也没关掉）才写灰鸠老师；再加作者自己写的 */
    function introCredits(s = S()) {
        const tpl = ruleList().find((r) => r.name === '人设模板');
        const extra = String(s.introThanks ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
        return [CREDIT_WORKSHOP, ...(tpl && tpl.on && !tpl.edited ? [CREDIT_TEMPLATE] : []), ...extra];
    }

    function composeIntroFor(d, s = S()) {
        const it = d.intro ?? {};
        return composeIntro(it.parts ?? {}, {
            title: it.titles?.[it.pick ?? 0] ?? d.concepts?.[d.pick]?.title ?? '',
            tags: d.tags,
            author: s.author,
            license: s.license ?? {},
            presetNote: s.presetNote || s.presetGreeting || '',
            notes: s.introNotes,
            charName: d.personas?.[0]?.name ?? '',
            credits: introCredits(s),
        }, introStyle(s));
    }

    return {
        banned, strip, restore, remember, slotOf, localEdit, routeOf, npcOne, relations, modeOf, ruleList, introCredits, noteChanges, styleOf,
        playGreetings, playStart, playChar, playUser, playAuto, playRedo, playReview, reviewTarget, playContext, charName, PLAY_STYLES,
        inspire, ideaFromInspire, ideaQA, hooks, expand, revise, textSlot, suggestRoutes, addRouteIdea, loadCard, backstory,
        auStart, auCore, auMap, auCheck, auFix, localTags, idea, pickConcept, qa, persona, world, npc, routes, tone, free, custom,
        greetings, predict, destale, localCheck, textSlots, intro, composeIntroFor, baseVars,
    };
}
