// 写卡工坊 · 本地质检与相似度（不调 API，不依赖 DOM）

const SENT_RX = /[^。！？!?；;\n]+[。！？!?；;]?/g;

export function sentences(text) {
    return (String(text ?? '').match(SENT_RX) || []).map((s) => s.trim()).filter((s) => s.length > 1);
}

const ACTIONS = /推了推眼镜|推眼镜|扶了扶眼镜|捏(?:着|紧)?衣角|攥(?:着|紧)?衣角|咬(?:着)?(?:笔杆|下唇|嘴唇)|挠(?:了挠)?(?:后脑勺|头)|揉(?:了揉)?(?:眉心|太阳穴)|摸(?:了摸)?鼻子|口头禅|口癖|招牌动作|标志性动作|标志性的(?:笑|动作)|习惯性地/g;
const NUMBERS = /\d{2,3}\s*(?:cm|CM|厘米|公分|kg|KG|公斤|斤)|三围|\d{2}\s*[-－/]\s*\d{2}\s*[-－/]\s*\d{2}|[A-H]\s*罩杯|罩杯|[0-9一二三四五六七八九十]+岁零[0-9一二三四五六七八九十]+个月/g;
const ASSERT = /永远|绝不|绝对不会|从不|从来不|只会|一定会|无条件/;
const REASON = /因为|由于|缘由|所以|因此|毕竟|除非|只要|如果|才会|直到|否则|前提/;
const BAN = /禁止|不要|不得|严禁|避免|不可以|不允许|不能写/;
const BAN_OK = /替代|缘由|改为|改成|换成|而是|取而代之|应当|应该|优先/;
const LABEL_LINE = /^\s*-?\s*(?:排除|缘由|替代)\s*[:：]/;
const ADJ = /美丽|华丽|古老|神秘|阴森|璀璨|宏伟|幽深|静谧|繁华|斑驳|昏暗|奢华|精致|无尽|永恒|深邃|冰冷|温暖|柔和|壮丽|诡异|庄严|肃穆|浩瀚|苍凉|绚丽|迷人|梦幻/g;
const STOP = /[的了是在和与他她它我你们这那个也都就而或被把〔〕<>]/;
const KEY_WORDS = new Set(['身份', '关系', '行为', '表现', '性格', '对白', '风格', '示例', '描述', '指导', '底色', '深层', '浅层', '红线', '排除', '缘由', '替代', '矛盾', '落点', '倾向', '日常', '决策', '社交', '反差', '外貌', '经历', '影响', '现在', '角色', '情境', '台词', '玩家', '信息', '主要', '标签', '解释', '复杂', '细节', '当前', '状态', '公开', '隐藏', '特殊', '世界', '规则']);

function push(out, type, level, label, match) {
    out.push({ type, level, label, match: String(match ?? '').slice(0, 60) });
}

/** 高频词：2–3 字的中文词，次数多且密度高时提醒 */
export function frequentWords(text, { ignore = [], min = 6, per = 180 } = {}) {
    const s = String(text ?? '').replace(/^[ \t]*[-\w一-鿿]{1,12}[:：]/gm, ' ');
    const counts = new Map();
    for (const n of [2, 3]) {
        for (const m of s.matchAll(/[一-鿿]+/g)) {
            const w = m[0];
            for (let i = 0; i + n <= w.length; i++) {
                const g = w.slice(i, i + n);
                if (STOP.test(g) || KEY_WORDS.has(g)) continue;
                counts.set(g, (counts.get(g) || 0) + 1);
            }
        }
    }
    const len = Math.max(1, s.length);
    const limit = Math.max(min, Math.ceil(len / per));
    const ign = ignore.filter(Boolean);
    const hits = [...counts.entries()]
        .filter(([g, c]) => c >= limit && !ign.some((x) => x.includes(g) || g.includes(x)))
        .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
    // 三字词命中时去掉被它包含、次数相同的二字词
    const out = [];
    for (const [g, c] of hits) {
        if (out.some((o) => o.word.includes(g) && o.count >= c)) continue;
        out.push({ word: g, count: c });
    }
    return out.slice(0, 6);
}

/** 人设里“浅层表现/深层底色”的标签有没有在“性格解释”里展开 */
export function unexplainedLabels(text) {
    const s = String(text ?? '');
    const i = s.search(/性格解释/);
    if (i < 0) return [];
    const head = s.slice(0, i);
    const body = s.slice(i);
    const labels = [];
    const sec = head.match(/(?:浅层表现|深层底色)\s*[:：][\s\S]*$/);
    if (!sec) return [];
    for (const m of sec[0].matchAll(/(?:^\s*-\s*([^\n:：]{1,12})\s*$)|\[([^\]]+)\]/gm)) {
        if (m[1]) labels.push(m[1].trim());
        if (m[2]) labels.push(...m[2].split(/[,，、]/).map((x) => x.trim()));
    }
    return [...new Set(labels.filter((l) => l && !/标签/.test(l)))].filter((l) => !body.includes(l));
}

/**
 * 本地扫描。kind：persona / world / tone / npc / route / greeting / intro / free
 * @returns {{type:string,level:'error'|'warn'|'info',label:string,match:string}[]}
 */
export function scanCard(text, kind, { names = [], pistol = false } = {}) {
    const s = String(text ?? '');
    const out = [];
    if (!s.trim()) return out;

    if (kind !== 'intro') {
        for (const m of s.matchAll(ACTIONS)) push(out, 'action', 'warn', '小动作/口头禅', m[0]);
    }
    if (['persona', 'npc', 'route', 'world', 'free'].includes(kind)) {
        for (const m of s.matchAll(NUMBERS)) push(out, 'number', 'warn', '数字堆砌', m[0]);
        for (const sen of sentences(s)) {
            if (LABEL_LINE.test(sen)) continue;
            if (ASSERT.test(sen) && !REASON.test(sen)) push(out, 'assert', 'warn', '无缘由断言', sen);
        }
    }
    if (['persona', 'tone', 'npc', 'route', 'free'].includes(kind)) {
        const lines = s.split('\n');
        lines.forEach((ln, i) => {
            if (!BAN.test(ln) || LABEL_LINE.test(ln) || BAN_OK.test(ln)) return;
            // 只看这一项自己的子行（缩进更深的行）里有没有缘由/替代
            const own = ln.match(/^\s*/)[0].length;
            const childMin = /^\s*-\s/.test(ln) ? own + 2 : own + 1;
            const children = [];
            for (let j = i + 1; j < lines.length && children.length < 4; j++) {
                if (!lines[j].trim()) continue;
                if (lines[j].match(/^\s*/)[0].length < childMin) break;
                children.push(lines[j]);
            }
            if (/替代|缘由/.test(children.join('\n'))) return;
            push(out, 'ban', 'warn', '只有禁止没有替代', ln.trim());
        });
    }
    if (kind === 'persona') {
        for (const l of unexplainedLabels(s)) push(out, 'label', 'error', '标签没有行为解释', l);
    }
    if (kind === 'world' && !pistol) {
        const adj = [...s.matchAll(ADJ)].map((m) => m[0]);
        if (adj.length) push(out, 'adj', adj.length > 4 ? 'warn' : 'info', `形容词 ${adj.length} 个（零度写作）`, [...new Set(adj)].join('、'));
    }
    if (['persona', 'npc', 'route', 'greeting', 'world'].includes(kind)) {
        for (const w of frequentWords(s, { ignore: names })) push(out, 'freq', 'info', `高频词 ×${w.count}`, w.word);
    }
    if (kind === 'intro') {
        if (/^\s*\|?\s*:?-{3,}:?\s*\|/m.test(s) || /^\s*\|.+\|.+\|\s*$/m.test(s)) push(out, 'table', 'error', 'Discord 简介不能用表格', '表格');
        const len = [...s].length;
        if (len > 4000) push(out, 'length', 'error', `${len} 字，超过 Discord 上限（Nitro 4000）`, '');
        else if (len > 2000) push(out, 'length', 'warn', `${len} 字，超过 2000（非 Nitro 需拆成两条）`, '');
    }
    return out;
}

// ───────────── 相似度（可预测性测试、NP 互相比对） ─────────────

function grams(s) {
    const t = String(s ?? '').replace(/[^一-鿿A-Za-z0-9]/g, '');
    const set = new Set();
    for (let i = 0; i + 2 <= t.length; i++) set.add(t.slice(i, i + 2));
    return set;
}

/** 二字片段 Dice 系数，0–1 */
export function similarity(a, b) {
    const A = grams(a);
    const B = grams(b);
    if (!A.size || !B.size) return 0;
    let n = 0;
    for (const g of A) if (B.has(g)) n++;
    return (2 * n) / (A.size + B.size);
}

/** 去掉 YAML 键名和标签，只留内容句子 */
export function contentSentences(text) {
    return sentences(String(text ?? '')
        .replace(/<\/?[^<>\n]{1,40}>/g, '\n')
        .replace(/^[ \t]*-?[ \t]*[^\n:：]{1,14}[:：][ \t]*/gm, ''))
        .filter((s) => s.replace(/[^一-鿿]/g, '').length >= 4);
}

/**
 * 可预测性：把 AI 只凭标签猜出的写法和卡里的句子比对。
 * predicted: {scenes:[{scene,behavior,line}], traits:[]}
 * 返回撞车列表（相似度从高到低）。
 */
export function predictOverlap(predicted, cardText, threshold = 0.42) {
    const card = contentSentences(cardText);
    const items = [];
    for (const sc of predicted?.scenes ?? []) {
        if (sc.behavior) items.push({ from: `${sc.scene}·行为`, text: sc.behavior });
        if (sc.line) items.push({ from: `${sc.scene}·台词`, text: sc.line });
    }
    for (const t of predicted?.traits ?? []) items.push({ from: '常见写法', text: t });
    const out = [];
    for (const it of items) {
        let best = { score: 0, sentence: '' };
        for (const s of card) {
            const sc = similarity(it.text, s);
            if (sc > best.score) best = { score: sc, sentence: s };
        }
        if (best.score >= threshold) out.push({ ...it, card: best.sentence, score: Math.round(best.score * 100) / 100 });
    }
    return out.sort((a, b) => b.score - a.score);
}

/** NP：两两比对主要角色，返回相似句子对较多的组合 */
export function crossCompare(personas, threshold = 0.5) {
    const names = Object.keys(personas ?? {});
    const out = [];
    for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
            const A = contentSentences(personas[names[i]]).map((s) => s.replaceAll(names[i], ''));
            const B = contentSentences(personas[names[j]]).map((s) => s.replaceAll(names[j], ''));
            const pairs = [];
            for (const a of A) for (const b of B) {
                const sc = similarity(a, b);
                if (sc >= threshold) pairs.push({ a, b, score: Math.round(sc * 100) / 100 });
            }
            pairs.sort((x, y) => y.score - x.score);
            if (pairs.length) out.push({ a: names[i], b: names[j], count: pairs.length, pairs: pairs.slice(0, 5) });
        }
    }
    return out.sort((x, y) => y.count - x.count);
}
