// 写卡工坊 · 各步骤的执行逻辑（不依赖 DOM，API 调用通过 call 注入，便于测试）

import { DEFAULT_PROMPTS, DEFAULT_RULES, PERSONA_TEMPLATE, SYSTEM_CARD, SYSTEM_PROSE, STEP_INFO, fill, ruleVars } from './prompts.js';
import { parseJSON, splitBlocks, blockOf, extractTagged, clip, stripWords, wordList, findWords } from './parse.js';
import { matchTags, sanitizeTags, toggleTag, tagsText, tagValue, libraryText, findTag, rollDice, PLATFORM_STYLE, dimOf } from './tags.js';
import { conceptText, answersText, overviewsText, routesText, composeIntro, parseTitles, orderedGreetings } from './assemble.js';
import { scanCard, predictOverlap, crossCompare } from './checks.js';

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

    const rules = () => ({ ...DEFAULT_RULES, ...(S().rules ?? {}) });
    const promptOf = (id) => (S().prompts?.[id]?.trim() ? S().prompts[id] : DEFAULT_PROMPTS[id]);
    const concept = (d) => d.concepts?.[d.pick] ?? null;
    const platform = (d) => tagValue(d.tags, 'platform').map((p) => `${p}：${PLATFORM_STYLE[p] ?? ''}`).join('；') || '主流网文，读者想一直读下去';
    const isPistol = (d) => tagValue(d.tags, 'cardType').includes('手枪卡');

    function baseVars(d) {
        return {
            idea: d.idea,
            tags: tagsText(d.tags, L()) || '（未选）',
            concept: conceptText(concept(d)),
            platform: platform(d),
            overviews: overviewsText(d),
            personas: clip((d.personas ?? []).map((p) => p.text).filter(Boolean).join('\n\n'), 6000),
            answers: answersText(d),
            world: clip([d.world?.main, ...(d.world?.extra ?? []).map((e) => e.content)].filter(Boolean).join('\n'), 2500) || '（无）',
            npcs: clip((d.npcs ?? []).map((n) => n.content).join('\n'), 2000) || '（无）',
            routes: routesText(d),
            tone: clip(d.tone, 1500) || '（无）',
            ...ruleVars(rules()),
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
            greet: { get: () => d.greetings.filter((g) => g.route === name).map((g) => g.text), set: (v) => { d.greetings = [...d.greetings.filter((g) => g.route !== name), ...v.map((text) => ({ route: name, text }))]; } },
            free: { get: () => fr()?.content ?? '', set: (v) => { const f = fr(); if (f) f.content = v; } },
            intro: { get: () => d.intro, set: (v) => { d.intro = v; } },
        }[kind];
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
    async function run(id, d, extra = {}, { stage, system, json = false, key, prev, close } = {}) {
        check();
        const info = STEP_INFO[id] ?? { name: id, stage: 'card', temp: 0.8 };
        progress(`${info.name}…`);
        let user = fill(promptOf(id), { ...baseVars(d), ...extra });
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

    async function idea(d) {
        const lib = L();
        const hits = localTags(d);
        const j = parseJSON(await run('idea', d, {
            matched: hits.map((h) => h.name).join('、') || '（无）',
            tagLibrary: libraryText(lib),
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
        d.personas = c.lineup.map((p) => old.get(p.name) ?? { name: p.name, keys: [], overview: '', text: '' });
        d.routes = c.routes.map((r) => ({ ...r, info: (d.routes ?? []).find((x) => x.name === r.name)?.info ?? '' }));
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

    async function persona(d, name) {
        const p = d.personas.find((x) => x.name === name);
        if (!p) throw new Error(`没有角色 ${name}`);
        const others = d.personas.filter((x) => x.name !== name);
        const lineup = concept(d)?.lineup ?? [];
        const otherText = others.length
            ? `【同卡的其他主要角色】\n${others.map((o) => `${o.name}：${o.overview || lineup.find((l) => l.name === o.name)?.identity || ''}`).join('\n')}`
            : '';
        const np = others.length || tagValue(d.tags, 'count').some((c) => c === 'NP' || c === '群像');
        const npRule = np ? `- 这张卡有多个主要角色。${name} 要占一个和其他人不同的张力位置（权力压制、旧情未了、立场敌对……），他对〔user〕的态度、他想要的东西、他的矛盾轴都不能和其他人重复。` : '';
        const answers = (d.qa?.chars ?? []).filter((c) => c.name === name).flatMap((c) => c.questions)
            .filter((q) => q.answer?.trim()).map((q) => `${q.q}\n→ ${q.answer.trim()}`).join('\n');
        const raw = await run('persona', d, {
            name,
            others: otherText,
            npRule,
            answers: answers || answersText(d),
            template: fill(PERSONA_TEMPLATE, { name }),
        }, { key: `persona:${name}`, prev: p.text, close: `</${name}>` });
        remember(d, `persona:${name}`, { overview: p.overview, text: p.text });
        const parsed = splitBlocks(raw);
        const body = blockOf(parsed, '人设') || parsed.lead || raw;
        p.overview = blockOf(parsed, '概要') || p.overview;
        p.text = extractTagged(body, name);
        return d;
    }

    // ───── 3. 世界观 ─────
    async function world(d) {
        const complexity = tagValue(d.tags, 'complexity')[0] ?? concept(d)?.complexity ?? '简单';
        const pistol = isPistol(d);
        const fandom = tagValue(d.tags, 'source').includes('同人') && d.fandom ? `【同人】${d.fandom}` : '';
        const raw = await run('world', d, {
            complexity,
            fandom,
            zeroRule: pistol ? '- 手枪卡：不用零度写作，简洁写清场景即可。' : rules()['零度写作'],
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
        const count = concept(d)?.npcs ?? 2;
        const raw = await run('npc', d, { count: count || 2 }, { key: 'npc', prev: (d.npcs ?? []).map((n) => n.content).join('\n') });
        remember(d, 'npc', d.npcs);
        const parsed = splitBlocks(raw);
        const list = parsed.blocks.filter((b) => b.body).map((b) => ({ name: b.name || '未命名', keys: b.keys, content: b.body }));
        if (!list.length && parsed.lead) list.push({ name: 'NPC', keys: [], content: parsed.lead });
        d.npcs = list;
        return d;
    }

    // ───── 5. 路线 ─────
    async function routes(d) {
        if (!d.routes?.length) d.routes = [{ name: '主线', user: '', period: '', info: '' }];
        const raw = await run('routes', d, {}, { key: 'routes', prev: d.routes.map((r) => r.info).join('\n') });
        remember(d, 'routes', d.routes.map((r) => r.info));
        const parsed = splitBlocks(raw);
        const blocks = parsed.blocks.filter((b) => b.body);
        if (!blocks.length && parsed.lead) blocks.push({ name: d.routes[0].name, body: parsed.lead });
        const used = new Set();
        for (const b of blocks) {
            let r = d.routes.find((x) => !used.has(x) && (x.name === b.name || (b.name && (x.name.includes(b.name) || b.name.includes(x.name)))));
            r ??= d.routes.find((x) => !used.has(x));
            if (!r) { r = { name: b.name || `路线${d.routes.length + 1}`, user: '', period: '', info: '' }; d.routes.push(r); }
            used.add(r);
            r.info = b.body;
        }
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
        progress(`${step.name}…`);
        const user = fill(step.template, { ...baseVars(d), name: step.name });
        const out = strip(await deps.llm({ system: withBan(step.stage === 'greeting' ? SYSTEM_PROSE : SYSTEM_CARD, d), user, stage: step.stage || 'card', temperature: 0.8 }));
        check();
        d.custom ??= {};
        d.custom[step.id] = out;
        if (step.output !== 'none') {
            let f = d.free.find((x) => x.fromStep === step.id);
            if (!f) { f = { name: step.name, desc: '', content: '', light: step.light || 'blue', keys: step.keys ?? [], position: step.position || 'after', fromStep: step.id }; d.free.push(f); }
            f.content = out;
        }
        return d;
    }

    // ───── 7. 开场白 ─────
    async function greetings(d, ri, n = S().greetingCount || 2) {
        const r = d.routes[ri] ?? { name: '主线', info: '' };
        const raw = await run('greeting', d, {
            route: r.name,
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
        p.text = extractTagged(raw, name);
        d.predict[name].overlaps = [];
        d.predict[name].rewritten = true;
        return d;
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
    function textSlots(d) {
        const slots = [];
        const slot = (label, kind, get, set) => { if (str(get())) slots.push({ label, kind, get, set }); };
        slot('基调与规则', '世界书条目', () => d.tone, (v) => { d.tone = v; });
        slot('世界观', '世界书条目', () => d.world.main, (v) => { d.world.main = v; });
        d.world.extra.forEach((e) => slot(`世界观·${e.name}`, '世界书条目', () => e.content, (v) => { e.content = v; }));
        d.personas.forEach((p) => {
            slot(`人设概要·${p.name}`, '人设', () => p.overview, (v) => { p.overview = v; });
            slot(`人设·${p.name}`, '人设', () => p.text, (v) => { p.text = v; });
        });
        d.npcs.forEach((n) => slot(`NPC·${n.name}`, '世界书条目', () => n.content, (v) => { n.content = v; }));
        d.routes.forEach((r) => slot(`路线·${r.name}`, '世界书条目', () => r.info, (v) => { r.info = v; }));
        d.free.forEach((f) => slot(`模块·${f.name}`, '世界书条目', () => f.content, (v) => { f.content = v; }));
        (d.greetings ?? []).forEach((g, i) => slot(`开场白 ${i + 1}`, '开场白', () => g.text, (v) => { g.text = v; }));
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
        });
    }

    return {
        banned, strip, restore, remember, slotOf,
        inspire, ideaFromInspire, localTags, idea, pickConcept, qa, persona, world, npc, routes, tone, free, custom,
        greetings, predict, destale, localCheck, textSlots, intro, composeIntroFor, baseVars,
    };
}
