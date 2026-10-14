// 写卡工坊 · 写回酒馆前先比对（三方比较）
// base   = 上次同步时（读卡 / 导入 / 写回）酒馆里的样子
// mine   = 写卡工坊现在的样子
// theirs = 酒馆现在的样子
// 只在写卡工坊改了、酒馆没改的地方默认写回；酒馆里改过的默认保留酒馆的，并拉回写卡工坊。

import { cardUpdate, buildCharacter, buildEntries, mergeWorld } from './assemble.js';

const norm = (x) => String(x ?? '').replace(/\r\n/g, '\n').trim();
export const CARD_FIELDS = ['description', 'personality', 'scenario', 'mes_example'];
export const FIELD_NAMES = { description: '角色描述', personality: '性格', scenario: '场景', mes_example: '对话示例' };

/** 酒馆里一张卡 + 世界书的样子 */
export function snapshotOf(cardData, worldData) {
    const entries = {};
    for (const e of Object.values(worldData?.entries ?? {})) {
        entries[`uid:${e.uid}`] = String(e.content ?? '');
        if (e.comment) entries[`c:${e.comment}`] = String(e.content ?? '');
    }
    return {
        fields: Object.fromEntries(CARD_FIELDS.map((k) => [k, String(cardData?.[k] ?? '')])),
        greetings: [cardData?.first_mes, ...(cardData?.alternate_greetings ?? [])].map((t) => String(t ?? '')).filter((t) => t.trim()),
        entries,
    };
}

/** 写卡工坊这边的样子（clean = 已经把占位符换回来的草稿） */
export function mineOf(clean, { personaPlace = 'blue' } = {}) {
    const ex = clean.existing;
    const fromImport = !!ex?.fromImport;
    let fields;
    if (fromImport) {
        fields = { description: buildCharacter(clean, { personaPlace }).description };
    } else {
        const up = cardUpdate(clean);
        fields = Object.fromEntries(CARD_FIELDS.map((k) => [k, up[k] ?? '']));
    }
    const view = fromImport ? clean : { ...clean, personas: (clean.personas ?? []).filter((p) => !p.fromDescription) };
    const place = fromImport ? personaPlace : (personaPlace === 'description' ? 'blue' : personaPlace);
    const specs = buildEntries(view, { personaPlace: place });
    const entries = [
        ...(ex?.entries ?? []).map((e) => ({ key: `uid:${e.uid}`, label: e.comment, content: String(e.content ?? ''), uid: e.uid })),
        ...specs.map((sp) => ({ key: `c:${sp.comment}`, label: sp.comment, content: sp.content, comment: sp.comment })),
    ];
    // 导入后再改：开场白靠 slot 记住它在酒馆里是第几个；改已有的卡：原来的开场白在 existing.greetings 里
    let orig = [...(ex?.greetings ?? [])];
    if (fromImport) {
        orig = [];
        for (const g of clean.greetings ?? []) if (Number.isInteger(g.slot)) orig[g.slot] = String(g.text ?? '');
    }
    return { fields, origGreetings: orig, newGreetings: newGreetingRefs(clean).map((g) => g.text), entries, place, view };
}

/** 还没写进酒馆的新开场白（按路线顺序），返回草稿里的原对象 */
export function newGreetingRefs(d) {
    const routes = (d.routes ?? []).map((r) => r.name);
    const rank = (g) => { const i = routes.indexOf(g.route); return i < 0 ? routes.length : i; };
    return (d.greetings ?? []).map((g, i) => ({ g, i })).filter((x) => String(x.g.text ?? '').trim() && !Number.isInteger(x.g.slot))
        .sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map((x) => x.g);
}

function classify(m, b, t) {
    if (t === undefined) return 'new';
    if (norm(m) === norm(t)) return 'same';
    if (b === undefined) return 'unknown';
    if (norm(m) === norm(b)) return 'theirs';
    if (norm(t) === norm(b)) return 'mine';
    return 'conflict';
}

/**
 * 列出每一处要不要写回。
 * status：mine（只有写卡工坊改了，默认写）/ new（新加的，默认写）/ theirs（只有酒馆里改了，默认保留酒馆的）
 *        / conflict（两边都改了，默认保留酒馆的）/ unknown（老草稿没有同步记录，默认不写）
 */
export function buildPlan(mine, base, theirs) {
    const items = [];
    const push = (it) => { if (it.status !== 'same') items.push({ ...it, checked: it.status === 'mine' || it.status === 'new' }); };
    for (const k of Object.keys(mine.fields)) {
        const m = mine.fields[k];
        // 两边都空着不算
        if (!norm(m) && !norm(theirs.fields[k])) continue;
        push({ id: `f:${k}`, kind: 'field', field: k, label: FIELD_NAMES[k] ?? k, mine: m, base: base?.fields?.[k], theirs: theirs.fields[k], status: classify(m, base?.fields?.[k], theirs.fields[k]) });
    }
    mine.origGreetings.forEach((m, i) => {
        const t = theirs.greetings[i];
        const b = base?.greetings?.[i];
        let st = t === undefined && !norm(m) ? 'same' : classify(m, b, t);
        if (st === 'new' && !norm(m)) st = 'same';
        push({ id: `g:${i}`, kind: 'greet', index: i, label: i === 0 ? '主开场白' : `开场白 ${i + 1}`, mine: m, base: b, theirs: t, status: st, deleted: !norm(m) });
    });
    mine.newGreetings.forEach((m, i) => push({ id: `n:${i}`, kind: 'newGreet', index: i, label: `新开场白 ${i + 1}`, mine: m, theirs: undefined, status: 'new' }));
    for (const e of mine.entries) {
        const t = theirs.entries[e.key];
        const b = base?.entries?.[e.key];
        push({ id: `e:${e.key}`, kind: 'entry', key: e.key, label: `世界书·${e.label}`, mine: e.content, base: b, theirs: t, status: classify(e.content, b, t) });
    }
    return items;
}

/**
 * 按勾选结果拼出要写进酒馆的卡和世界书。
 * 不勾的地方一律用酒馆现在的；酒馆里自己加的开场白、条目都保留。
 */
export function applyPlan(items, { theirsCard, theirsWorld, clean, mine }) {
    const on = new Set(items.filter((x) => x.checked).map((x) => x.id));
    const cardData = {};
    for (const it of items) if (it.kind === 'field' && on.has(it.id)) cardData[it.field] = it.mine;
    // 开场白：从酒馆现在的列表出发，替换勾选的，再把勾选的新开场白接在后面
    const greetings = [theirsCard.first_mes, ...(theirsCard.alternate_greetings ?? [])].map((t) => String(t ?? ''));
    for (const it of items) if (it.kind === 'greet' && on.has(it.id)) greetings[it.index] = it.mine;
    const added = items.filter((it) => it.kind === 'newGreet' && on.has(it.id));
    for (const it of added) greetings.push(it.mine);
    const finalGreetings = greetings.filter((t) => String(t ?? '').trim());
    const greetChanged = items.some((it) => (it.kind === 'greet' || it.kind === 'newGreet') && on.has(it.id));
    if (greetChanged) {
        cardData.first_mes = finalGreetings[0] ?? '';
        cardData.alternate_greetings = finalGreetings.slice(1);
    }
    // 世界书：从酒馆现在的出发，只换勾选的条目
    const world = structuredClone(theirsWorld ?? { entries: {} });
    world.entries ??= {};
    const full = mergeWorld(theirsWorld ?? { entries: {} }, mine.view, { personaPlace: mine.place });
    const byComment = (w, c) => Object.values(w.entries).find((e) => e.comment === c);
    let worldChanged = false;
    for (const it of items) {
        if (it.kind !== 'entry' || !on.has(it.id)) continue;
        worldChanged = true;
        if (it.key.startsWith('uid:')) {
            const uid = it.key.slice(4);
            if (world.entries[uid]) world.entries[uid].content = it.mine;
            continue;
        }
        const comment = it.key.slice(2);
        const src = byComment(full, comment);
        if (!src) continue;
        const cur = byComment(world, comment);
        if (cur) { cur.content = src.content; cur.key = src.key; }
        else {
            const uid = Math.max(-1, ...Object.keys(world.entries).map(Number).filter(Number.isFinite)) + 1;
            world.entries[uid] = { ...structuredClone(src), uid, displayIndex: uid };
        }
    }
    return { cardData, world, worldChanged, finalGreetings, written: added };
}

/** 同步完之后的 base：写回的用写卡工坊的，保留酒馆的用酒馆的，这次没勾的保持原样（下次还会提示） */
export function nextBase(items, oldBase, finalSnapshot) {
    const base = structuredClone(finalSnapshot);
    for (const it of items) {
        if (it.checked || it.status !== 'mine') continue;
        // 写卡工坊改了但这次没写：base 保持旧的，下次还会出现在列表里
        if (it.kind === 'field') base.fields[it.field] = oldBase?.fields?.[it.field] ?? it.theirs;
        if (it.kind === 'entry') base.entries[it.key] = oldBase?.entries?.[it.key] ?? it.theirs;
        if (it.kind === 'greet') base.greetings[it.index] = oldBase?.greetings?.[it.index] ?? it.theirs;
    }
    return base;
}

export const STATUS_TEXT = {
    mine: '写卡工坊改了',
    new: '新加的',
    theirs: '酒馆里改过',
    conflict: '两边都改了',
    unknown: '不一样（没有上次的记录）',
};
