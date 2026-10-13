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

/**
 * 把 AI 写的各段拼成 Discord 简介
 * parts: {标题, 题句, 简介, 关于TA, 路线, 内心想法}
 */
export function composeIntro(parts, { title = '', tags = [], author = '', license = {}, presetNote = '', notes = '', charName = '' } = {}) {
    const out = [];
    const tagLine = introTags(tags).join('|');
    out.push(`${tagLine ? `【${tagLine}】` : ''}${title}`.trim());
    out.push('');
    if (author) out.push(`-# 作者：**${author}**`);
    const lic = [['二传', license.repost], ['二改', license.edit], ['商用', license.commercial]].filter(([, v]) => v).map(([k, v]) => `${k}：${v}`).join('｜');
    if (lic) out.push(`-# ${lic}`);
    const motto = String(parts['题句'] ?? '').trim();
    if (motto) {
        out.push('');
        const ls = motto.split('\n').filter((l) => l.trim());
        out.push(ls.map((l, i) => (i === 0 && /[A-Za-z]/.test(l) && !/^\*/.test(l) ? `> *${l.replace(/^>\s*/, '')}*` : `> ${l.replace(/^>\s*/, '')}`)).join('\n'));
    }
    out.push('', '┈┈┈┈ ୨୧ ┈┈┈┈', '', '## ✦ 简介', '');
    out.push(String(parts['简介'] ?? '').replace(/^\s*\|\|\s*无\s*\|\|\s*$/gm, '').trim());
    if (String(parts['关于TA'] ?? '').trim()) {
        out.push('', '──── ⋆⋅✧⋅⋆ ────', '', '## 关于TA', '', String(parts['关于TA']).trim());
    }
    const routes = String(parts['路线'] ?? '').trim();
    if (routes && !/^（?(?:无|省略|没有)/.test(routes)) {
        out.push('', '## 路线', '', quote(routes));
    }
    const inner = String(parts['内心想法'] ?? '').trim();
    if (inner) {
        out.push('', '⊹ ───── ⟡ ───── ⊹', '', '## 内心想法', '', quote(inner) + (charName ? `\n> -# ——${charName}` : ''));
    }
    if (presetNote || notes) {
        out.push('', '┄┄┄┄ ☾ ┄┄┄┄', '', '## 使用说明', '');
        if (presetNote) out.push(`**预设参考**：${presetNote}`);
        if (notes) out.push(`-# ${notes}`);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseTitles(text) {
    return String(text ?? '').split('\n')
        .map((l) => l.replace(/^\s*(?:(?:[-*•]|\d+[.、)]|标题[一二三四五12345]?[:：])\s*)+/, '').replace(/^[《「“"]|[》」”"]$/g, '').trim())
        .filter(Boolean).slice(0, 5);
}
