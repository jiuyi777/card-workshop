// 写卡工坊 · 组装世界书、角色卡和简介（不依赖 DOM）

import { introTags } from './tags.js';

/**
 * 草稿结构
 * @typedef {{
 *  name:string, idea:string, tags:{dim:string,name:string}[],
 *  concepts:any[], pick:number, fandom?:string,
 *  qa:{chars:{name:string,questions:{q:string,options:string[],answer?:string}[]}[]},
 *  personas:{name:string,keys:string[],overview:string,text:string}[],
 *  world:{main:string,extra:{name:string,keys:string[],content:string}[]},
 *  npcs:{name:string,keys:string[],content:string}[],
 *  routes:{name:string,user:string,period:string,info:string}[],
 *  tone:string,
 *  free:{name:string,desc:string,content:string,light:'blue'|'green',keys:string[],position:'before'|'after'}[],
 *  greetings:{route:string,text:string}[],
 *  intro:{titles:string[],pick:number,parts:Record<string,string>,text:string},
 * }} Draft
 */

export function emptyDraft() {
    return {
        version: 1,
        id: `d${Date.now().toString(36)}`,
        name: '',
        updated: Date.now(),
        idea: '',
        dice: {},
        inspire: [],
        tags: [],
        ai: { guessed: [], novel: [], surprise: null },
        concepts: [],
        pick: 0,
        fandom: '',
        check: [],
        qa: { chars: [] },
        personas: [],
        world: { main: '', extra: [] },
        npcs: [],
        routes: [],
        tone: '',
        free: [],
        greetings: [],
        intro: { titles: [], pick: 0, parts: {}, text: '' },
        predict: {},
        custom: {},
        ideaQA: [],
        hooks: {},
        feedback: {},
        history: {},
        truncated: {},
    };
}

/** 把构想写成提示词里的文字 */
export function conceptText(c) {
    if (!c) return '（没有构想）';
    const lines = [];
    if (c.title) lines.push(`标题：${c.title}`);
    for (const p of c.lineup ?? []) lines.push(`主要角色：${p.name}｜${p.identity ?? ''}${p.archetype?.length ? `｜原型：${[].concat(p.archetype).join('、')}` : ''}`);
    if (c.user?.length) lines.push(`〔user〕身份：${[].concat(c.user).join(' / ')}`);
    if (c.relation) lines.push(`关系与前情：${c.relation}`);
    if (c.tension?.core) lines.push(`核心张力：${c.tension.core}`);
    if (c.tension?.expect?.length) lines.push(`期待点：${c.tension.expect.join('；')}`);
    if (c.complexity) lines.push(`世界观复杂度：${c.complexity}${c.reason ? `（${c.reason}）` : ''}`);
    return lines.join('\n');
}

export function answersText(draft) {
    const out = [];
    for (const ch of draft?.qa?.chars ?? []) {
        for (const q of ch.questions ?? []) {
            if (q.answer?.trim()) out.push(`${ch.name}｜${q.q}\n→ ${q.answer.trim()}`);
        }
    }
    for (const q of draft?.inspire ?? []) if (q.answer?.trim()) out.push(`${q.q}\n→ ${q.answer.trim()}`);
    return out.join('\n') || '（作者没有回答，按构想自行决定）';
}

export function overviewsText(draft) {
    return (draft?.personas ?? []).filter((p) => p.overview?.trim()).map((p) => `${p.name}：${p.overview.trim()}`).join('\n') || '（还没有）';
}

export function routesText(draft) {
    return (draft?.routes ?? []).map((r, i) => `${i + 1}. ${r.name}｜〔user〕身份：${r.user || '未定'}｜时期：${r.period || '未定'}`).join('\n') || '（单路线）';
}

// ───────────── 世界书 ─────────────

export const POS = { before: 0, after: 1 };

const ENTRY_DEFAULTS = {
    key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false, selective: true,
    selectiveLogic: 0, addMemo: true, order: 100, position: 1, disable: false, ignoreBudget: false,
    excludeRecursion: false, preventRecursion: false, matchPersonaDescription: false, matchCharacterDescription: false,
    matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
    delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4, outletName: '', group: '',
    groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null,
    useGroupScoring: null, automationId: '', role: 0, sticky: null, cooldown: null, delay: null, triggers: [],
};

const keysOf = (list) => [...new Set((list ?? []).map((k) => String(k).trim()).filter(Boolean))];

/**
 * 按桶型结构生成条目规格：
 * 基调（角色前，蓝灯）→ 世界观（角色后，蓝灯）→ 人设概要（蓝灯）→ 人设（绿灯）→ NPC（绿灯）→ 路线（蓝灯，只开第一条）→ 自由模块
 */
/**
 * personaPlace：blue = 人设蓝灯常驻（默认）；green = 人设绿灯 + 蓝灯概要；description = 人设写进角色描述，不进世界书
 */
export function buildEntries(draft, { personaPlace = 'blue', personaBlue, activeRoute = 0 } = {}) {
    if (personaBlue === true) personaPlace = 'blue';
    const out = [];
    const add = (o) => { if (o.content?.trim()) out.push({ ...o, content: o.content.trim() }); };

    add({ comment: '基调与规则', content: draft.tone, constant: true, position: POS.before, order: 100 });
    add({ comment: '世界观', content: draft.world?.main, constant: true, position: POS.after, order: 200 });
    for (const e of draft.world?.extra ?? []) {
        add({ comment: `世界观·${e.name}`, content: e.content, constant: !keysOf(e.keys).length, key: keysOf(e.keys), position: POS.after, order: 210 });
    }
    const ov = personaPlace === 'green' ? (draft.personas ?? []).filter((p) => p.overview?.trim()) : [];
    if (ov.length) {
        add({ comment: '人设概要', content: `<人设概要>\n${ov.map((p) => `${p.name}：${p.overview.trim()}`).join('\n')}\n</人设概要>`, constant: true, position: POS.after, order: 300 });
    }
    if (personaPlace !== 'description') {
        for (const p of draft.personas ?? []) {
            const keys = keysOf([p.name, ...(p.keys ?? [])]);
            add({ comment: `人设·${p.name}`, content: p.text, constant: personaPlace !== 'green', key: keys, position: POS.after, order: 400 });
        }
    }
    for (const n of draft.npcs ?? []) {
        add({ comment: `NPC·${n.name}`, content: n.content, constant: false, key: keysOf([n.name, ...(n.keys ?? [])]), position: POS.after, order: 450 });
    }
    (draft.routes ?? []).forEach((r, i) => {
        add({ comment: `路线·${r.name}`, content: r.info, constant: true, position: POS.after, order: 500, disable: i !== activeRoute });
    });
    for (const f of draft.free ?? []) {
        const keys = keysOf(f.keys);
        add({ comment: `模块·${f.name}`, content: f.content, constant: f.light !== 'green' || !keys.length, key: keys, position: POS[f.position] ?? POS.after, order: 600 });
    }
    return out;
}

/** 条目规格 → 酒馆世界书数据 */
export function toWorldData(entries) {
    const data = { entries: {} };
    entries.forEach((e, uid) => {
        data.entries[uid] = {
            ...structuredClone(ENTRY_DEFAULTS),
            uid,
            displayIndex: uid,
            key: e.key ?? [],
            comment: e.comment,
            content: e.content,
            constant: !!e.constant,
            order: e.order ?? 100,
            position: e.position ?? POS.after,
            disable: !!e.disable,
        };
    });
    return data;
}

/** 世界书重名时加序号 */
export function uniqueName(name, existing) {
    const base = String(name || '新角色').replace(/[\\/:*?"<>|]/g, '').trim() || '新角色';
    const set = new Set(existing ?? []);
    if (!set.has(base)) return base;
    for (let i = 2; i < 1000; i++) if (!set.has(`${base} (${i})`)) return `${base} (${i})`;
    return `${base} ${Date.now()}`;
}

/** 开场白顺序：路线顺序，每条路线内按生成顺序 */
export function orderedGreetings(draft) {
    const routes = (draft.routes ?? []).map((r) => r.name);
    const list = [...(draft.greetings ?? [])].filter((g) => g.text?.trim());
    const rank = (g) => { const i = routes.indexOf(g.route); return i < 0 ? routes.length : i; };
    return list.map((g, i) => ({ ...g, i })).sort((a, b) => rank(a) - rank(b) || a.i - b.i);
}

/** 生成 /api/characters/create 的请求体 */
export function buildCharacter(draft, { worldName = '', creator = '', intro = '', personaPlace = 'blue' } = {}) {
    const greetings = orderedGreetings(draft).map((g) => g.text.trim());
    const name = String(draft.name || draft.personas?.[0]?.name || draft.concepts?.[draft.pick]?.title || '新角色').trim();
    return {
        ch_name: name,
        description: personaPlace === 'description' ? (draft.personas ?? []).map((p) => p.text?.trim()).filter(Boolean).join('\n\n') : '',
        personality: '',
        scenario: '',
        first_mes: greetings[0] ?? '',
        mes_example: '',
        creator_notes: intro,
        system_prompt: '',
        post_history_instructions: '',
        creator,
        character_version: '1.0',
        tags: (draft.tags ?? []).map((t) => t.name),
        talkativeness: '0.5',
        world: worldName,
        depth_prompt_prompt: '',
        depth_prompt_depth: '4',
        depth_prompt_role: 'system',
        fav: 'false',
        alternate_greetings: greetings.slice(1),
        extensions: '{}',
    };
}

/** 递归换掉草稿里的占位符（导入时用） */
export function mapStrings(obj, fn) {
    if (typeof obj === 'string') return fn(obj);
    if (Array.isArray(obj)) return obj.map((x) => mapStrings(x, fn));
    if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, mapStrings(v, fn)]));
    return obj;
}

// ───────────── 简介 ─────────────

const quote = (text) => String(text ?? '').split('\n').map((l) => (l.trim() ? (l.startsWith('>') ? l : `> ${l}`) : '>')).join('\n');

/** 默认简介风格。{{#块}}…{{/块}}：这一块没内容时整段省略；{{变量|引用}}：每行前加 > */
export const DEFAULT_INTRO_STYLE = `{{#标签}}【{{标签}}】{{/标签}}{{标题}}

{{#作者}}-# 作者：**{{作者}}**{{/作者}}
{{#授权}}-# {{授权}}{{/授权}}

{{#题句}}{{题句|题句}}{{/题句}}

┈┈┈┈ ୨୧ ┈┈┈┈

## ✦ 简介

{{简介}}

{{#关于TA}}──── ⋆⋅✧⋅⋆ ────

## 关于TA

{{关于TA}}{{/关于TA}}

{{#路线}}## 路线

{{路线|引用}}{{/路线}}

{{#内心想法}}⊹ ───── ⟡ ───── ⊹

## 内心想法

{{内心想法|引用}}
{{#角色名}}> -# ——{{角色名}}{{/角色名}}{{/内心想法}}

{{#使用说明}}┄┄┄┄ ☾ ┄┄┄┄

## 使用说明

{{使用说明}}{{/使用说明}}`;

export const INTRO_VARS = ['标签', '标题', '作者', '授权', '题句', '简介', '关于TA', '路线', '内心想法', '角色名', '使用说明'];

const FILTERS = {
    引用: quote,
    小字: (t) => String(t ?? '').split('\n').map((l) => (l.trim() ? `-# ${l}` : l)).join('\n'),
    题句: (t) => String(t ?? '').split('\n').filter((l) => l.trim()).map((l, i) => {
        const x = l.replace(/^>\s*/, '');
        return i === 0 && /[A-Za-z]/.test(x) && !/^\*/.test(x) ? `> *${x}*` : `> ${x}`;
    }).join('\n'),
};

/** 按简介风格模板排版 */
export function renderIntro(tpl, vars) {
    let out = String(tpl ?? '');
    const has = (k) => String(vars[k] ?? '').trim() !== '';
    for (let i = 0; i < 10; i++) {
        const next = out.replace(/\{\{#([^{}|]+?)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, body) => (has(k.trim()) ? body : ''));
        if (next === out) break;
        out = next;
    }
    out = out.replace(/\{\{\s*([^{}|\s]+)\s*(?:\|\s*([^{}\s]+)\s*)?\}\}/g, (m, k, f) => {
        if (!(k in vars)) return m;
        const v = String(vars[k] ?? '').trim();
        return f && FILTERS[f] ? FILTERS[f](v) : v;
    });
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 把 AI 写的各段拼成 Discord 简介
 * parts: {标题, 题句, 简介, 关于TA, 路线, 内心想法}
 */
export function composeIntro(parts, { title = '', tags = [], author = '', license = {}, presetNote = '', notes = '', charName = '' } = {}, style = DEFAULT_INTRO_STYLE) {
    const routes = String(parts['路线'] ?? '').trim();
    const notesText = [presetNote ? `**预设参考**：${presetNote}` : '', notes ? `-# ${notes}` : ''].filter(Boolean).join('\n');
    const vars = {
        标签: introTags(tags).join('|'),
        标题: title,
        作者: author,
        授权: [['二传', license.repost], ['二改', license.edit], ['商用', license.commercial]].filter(([, v]) => v).map(([k, v]) => `${k}：${v}`).join('｜'),
        题句: String(parts['题句'] ?? '').trim(),
        简介: String(parts['简介'] ?? '').replace(/^\s*\|\|\s*无\s*\|\|\s*$/gm, '').trim(),
        关于TA: String(parts['关于TA'] ?? '').trim(),
        路线: /^（?(?:无|省略|没有)/.test(routes) ? '' : routes,
        内心想法: String(parts['内心想法'] ?? '').trim(),
        角色名: charName,
        使用说明: notesText,
    };
    return renderIntro(style || DEFAULT_INTRO_STYLE, vars);
}

export function parseTitles(text) {
    return String(text ?? '').split('\n')
        .map((l) => l.replace(/^\s*(?:(?:[-*•]|\d+[.、)]|标题[一二三四五12345]?[:：])\s*)+/, '').replace(/^[《「“"]|[》」”"]$/g, '').trim())
        .filter(Boolean).slice(0, 5);
}

// ───────────── 改已有的卡 ─────────────

const COMMENT_KINDS = [
    [/^基调与规则$/, 'tone'],
    [/^世界观$/, 'world'],
    [/^世界观·(.+)$/, 'worldExtra'],
    [/^人设概要$/, 'overview'],
    [/^人设·(.+)$/, 'persona'],
    [/^NPC·(.+)$/, 'npc'],
    [/^路线·(.+)$/, 'route'],
    [/^模块·(.+)$/, 'free'],
];

/** 角色卡内嵌世界书（character_book）的条目 → 酒馆世界书条目的样子 */
export function bookToWorld(book) {
    const data = { entries: {} };
    (book?.entries ?? []).forEach((e, i) => {
        const uid = Number.isInteger(e.id) ? e.id : i;
        data.entries[uid] = {
            ...structuredClone(ENTRY_DEFAULTS),
            uid,
            key: e.keys ?? [],
            keysecondary: e.secondary_keys ?? [],
            comment: e.comment ?? e.name ?? '',
            content: e.content ?? '',
            constant: !!e.constant,
            order: e.insertion_order ?? 100,
            position: e.extensions?.position ?? (e.position === 'before_char' ? 0 : 1),
            disable: e.enabled === false,
            depth: e.extensions?.depth ?? 4,
        };
    });
    return data;
}

/** 世界书 → 角色卡内嵌世界书，写回时让卡里嵌的那份也同步 */
export function worldToBook(name, data) {
    return {
        name,
        entries: Object.values(data?.entries ?? {}).map((e) => ({
            id: e.uid,
            keys: e.key ?? [],
            secondary_keys: e.keysecondary ?? [],
            comment: e.comment ?? '',
            content: e.content ?? '',
            constant: !!e.constant,
            selective: e.selective ?? true,
            insertion_order: e.order ?? 100,
            enabled: !e.disable,
            position: e.position == 0 ? 'before_char' : 'after_char',
            use_regex: true,
            extensions: { position: e.position, display_index: e.displayIndex ?? e.uid, depth: e.depth ?? 4, probability: e.probability ?? 100, useProbability: e.useProbability ?? true, selectiveLogic: e.selectiveLogic ?? 0, role: e.role ?? 0, exclude_recursion: !!e.excludeRecursion, prevent_recursion: !!e.preventRecursion },
        })),
    };
}

/**
 * 读一张已有的卡：写卡工坊生成的条目按名字认回各个步骤，其他条目原样放进“原卡内容”。
 * @param {any} card 角色卡（/api/characters/get 的返回）
 * @param {any} worldData 绑定的世界书数据（没有就用卡里嵌的那份）
 * @param {string} worldName
 */
export function cardToDraft(card, worldData, worldName = '') {
    const data = card?.data ?? card ?? {};
    const name = String(data.name ?? card?.name ?? '').trim() || '未命名';
    const d = emptyDraft();
    d.name = name;
    d.nameAuto = false;
    const book = worldData ?? (data.character_book ? bookToWorld(data.character_book) : { entries: {} });
    const overviews = {};
    const others = [];
    for (const e of Object.values(book.entries ?? {}).sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid))) {
        const comment = String(e.comment ?? '').trim();
        const content = String(e.content ?? '');
        let kind = null;
        let m = null;
        for (const [rx, k] of COMMENT_KINDS) { m = comment.match(rx); if (m) { kind = k; break; } }
        const keys = (e.key ?? []).filter((k) => k !== m?.[1]);
        if (kind === 'tone') d.tone = content;
        else if (kind === 'world') d.world.main = content;
        else if (kind === 'worldExtra') d.world.extra.push({ name: m[1], keys, content });
        else if (kind === 'overview') {
            for (const line of content.replace(/<\/?人设概要>/g, '').split('\n')) {
                const mm = line.match(/^\s*([^：:]{1,20})[：:]\s*(.+)$/);
                if (mm) overviews[mm[1].trim()] = mm[2].trim();
            }
        } else if (kind === 'persona') d.personas.push({ name: m[1], keys, overview: '', text: content });
        else if (kind === 'npc') d.npcs.push({ name: m[1], keys, content });
        else if (kind === 'route') d.routes.push({ name: m[1], user: '', period: '', info: content, orig: true });
        else if (kind === 'free') d.free.push({ name: m[1], desc: '', content, light: e.constant ? 'blue' : 'green', keys, position: e.position === 0 ? 'before' : 'after' });
        else others.push({ uid: e.uid, comment: comment || `条目 ${e.uid}`, key: e.key ?? [], content, constant: !!e.constant, disable: !!e.disable });
    }
    for (const p of d.personas) p.overview = overviews[p.name] ?? '';
    const description = String(data.description ?? '');
    // 没有“人设·”条目时，角色描述就是人设
    if (!d.personas.length && description.trim()) d.personas.push({ name, keys: [], overview: '', text: description, fromDescription: true });
    d.tags = (data.tags ?? []).map((t) => ({ dim: 'other', name: String(t) }));
    d.existing = {
        avatar: card?.avatar ?? '',
        name,
        world: worldName,
        hadWorld: !!worldName,
        fields: {
            description: d.personas.some((p) => p.fromDescription) ? '' : description,
            personality: String(data.personality ?? ''),
            scenario: String(data.scenario ?? ''),
            mes_example: String(data.mes_example ?? ''),
        },
        entries: others,
        greetings: [data.first_mes, ...(data.alternate_greetings ?? [])].map((t) => String(t ?? '')).filter((t) => t.trim()),
        loaded: Date.now(),
    };
    d.pick = -1;
    return d;
}

/** 已有卡的简要内容，代替“构想”给 AI 当上下文 */
export function existingSummary(d) {
    const ex = d.existing;
    if (!ex) return '';
    const cut = (t, n) => { const s = String(t ?? '').trim(); return s.length > n ? `${s.slice(0, n)}……` : s; };
    const parts = [`卡名：${ex.name}`];
    const ov = (d.personas ?? []).map((p) => (p.overview ? `${p.name}：${p.overview}` : `${p.name}：${cut(p.text, 600)}`)).join('\n');
    if (ov) parts.push(`主要角色：\n${ov}`);
    if (ex.fields.description) parts.push(`角色描述：${cut(ex.fields.description, 600)}`);
    if (ex.fields.scenario) parts.push(`场景：${cut(ex.fields.scenario, 300)}`);
    if (d.world?.main) parts.push(`世界观：${cut(d.world.main, 500)}`);
    const other = (ex.entries ?? []).filter((e) => !e.disable).slice(0, 6).map((e) => `${e.comment}：${cut(e.content, 200)}`).join('\n');
    if (other) parts.push(`其他设定：\n${other}`);
    if (ex.greetings?.[0]) parts.push(`开场白节选：${cut(ex.greetings[0], 300)}`);
    return parts.join('\n');
}

/**
 * 把草稿合并进原来的世界书：原有条目按 uid 改内容；写卡工坊的条目按名字找，找到就改，找不到就新建。
 * 不删任何条目。返回新的世界书数据。
 */
export function mergeWorld(worldData, d, { personaPlace = 'blue' } = {}) {
    const data = structuredClone(worldData ?? { entries: {} });
    data.entries ??= {};
    for (const e of d.existing?.entries ?? []) {
        const w = data.entries[e.uid];
        if (w) { w.content = e.content; w.disable = !!e.disable; }
    }
    const view = { ...d, personas: (d.personas ?? []).filter((p) => !p.fromDescription) };
    const specs = buildEntries(view, { personaPlace });
    const byComment = new Map(Object.values(data.entries).map((e) => [e.comment, e]));
    let next = Math.max(-1, ...Object.keys(data.entries).map(Number).filter(Number.isFinite)) + 1;
    const hasActiveRoute = Object.values(data.entries).some((e) => String(e.comment).startsWith('路线·') && !e.disable);
    for (const s of specs) {
        const w = byComment.get(s.comment);
        if (w) {
            w.content = s.content;
            if (s.key?.length) w.key = [...new Set([...(w.key ?? []), ...s.key])];
            continue;
        }
        const isRoute = s.comment.startsWith('路线·');
        const entry = toWorldData([{ ...s, disable: isRoute ? hasActiveRoute || !!s.disable : !!s.disable }]).entries[0];
        entry.uid = next;
        entry.displayIndex = next;
        data.entries[next] = entry;
        next++;
    }
    return data;
}

/** 写回角色卡的字段 */
export function cardUpdate(d) {
    const ex = d.existing;
    const fromDesc = (d.personas ?? []).find((p) => p.fromDescription);
    const greetings = [...(ex.greetings ?? []), ...orderedGreetings(d).map((g) => g.text)].map((t) => String(t).trim()).filter(Boolean);
    return {
        description: fromDesc ? fromDesc.text : ex.fields.description,
        personality: ex.fields.personality,
        scenario: ex.fields.scenario,
        mes_example: ex.fields.mes_example,
        first_mes: greetings[0] ?? '',
        alternate_greetings: greetings.slice(1),
    };
}
