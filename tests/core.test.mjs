// node tests/core.test.mjs
import assert from 'node:assert/strict';
import { buildLibrary, matchTags, hasTrigger, toggleTag, sanitizeTags, tagsText, introTags, libraryText, rollDice } from '../src/tags.js';
import { fill, ruleVars, DEFAULT_RULES, DEFAULT_PROMPTS, PERSONA_TEMPLATE } from '../src/prompts.js';
import { parseJSON, splitBlocks, blockOf, shield, unshield, extractTagged } from '../src/parse.js';
import { scanCard, similarity, predictOverlap, crossCompare, unexplainedLabels, frequentWords } from '../src/checks.js';
import { emptyDraft, buildEntries, toWorldData, buildCharacter, composeIntro, uniqueName, orderedGreetings, parseTitles, mapStrings } from '../src/assemble.js';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

const lib = buildLibrary({ era: ['蒸汽朋克|蒸汽,齿轮城'] });

await check('标签：英文触发词按单词边界，HE 不会命中 THE', () => {
    assert.equal(hasTrigger('THE END', 'HE'), false);
    assert.equal(hasTrigger('想要一个HE结局', 'HE'), true);
    assert.equal(hasTrigger('bg小甜文', 'BG'), true);
});

await check('标签：一句话自动识别，单选维度只留一个', () => {
    const hits = matchTags('我想看一个BG小甜文，青梅竹马，现代校园', lib);
    const names = hits.map((h) => h.name);
    for (const n of ['BG', '甜宠', '青梅竹马', '现言', '校园']) assert.ok(names.includes(n), n);
    assert.equal(hits.filter((h) => h.dim === 'cp').length, 1);
});

await check('标签：自定义标签生效，单选替换，AI 返回的未知标签被丢掉', () => {
    assert.ok(matchTags('齿轮城里的故事', lib).some((h) => h.name === '蒸汽朋克'));
    let sel = toggleTag([], lib, 'cp', 'BG');
    sel = toggleTag(sel, lib, 'cp', 'BL');
    assert.deepEqual(sel, [{ dim: 'cp', name: 'BL' }]);
    sel = toggleTag(sel, lib, 'era', '现言');
    sel = toggleTag(sel, lib, 'era', '校园');
    assert.equal(sel.length, 3);
    assert.deepEqual(sanitizeTags(['青梅竹马', '不存在的标签', { dim: 'cp', name: 'GL' }], lib), [{ dim: 'relation', name: '青梅竹马' }, { dim: 'cp', name: 'GL' }]);
    assert.match(tagsText(sel, lib), /性向：BL.*时代与题材：现言、校园/);
    assert.ok(libraryText(lib).includes('角色原型：霸总'));
    assert.ok(!libraryText(lib).includes('世界观复杂度'));
});

await check('标签：简介标签最多 8 个，性向和人数在前', () => {
    const sel = [{ dim: 'flavor', name: '甜宠' }, { dim: 'cp', name: 'BG' }, { dim: 'count', name: '1v1' }, { dim: 'era', name: '现言' }];
    assert.deepEqual(introTags(sel), ['BG', '1v1', '现言', '甜宠']);
});

await check('灵感骰子：锁定的维度不变', () => {
    const d = rollDice(lib, { relation: '宿敌' }, () => 0);
    assert.equal(d.relation, '宿敌');
    assert.equal(d.era, '现言');
});

await check('模板：只替换已有变量，酒馆宏原样保留，规则库展开', () => {
    const out = fill('{{name}}和{{user}}，{{char}}。{{rules.通用}}', { name: '黎曙', ...ruleVars({ 通用: 'R' }) });
    assert.equal(out, '黎曙和{{user}}，{{char}}。R');
    assert.ok(DEFAULT_PROMPTS.persona.includes('{{rules.矛盾建模}}'));
    assert.ok(Object.keys(DEFAULT_RULES).includes('零度写作'));
    assert.ok(PERSONA_TEMPLATE.includes('矛盾轴'));
});

await check('解析：带代码块、尾逗号、前后废话的 JSON', () => {
    const raw = '<think>想一下</think>好的：\n```json\n{"a":[1,2,],"b":{"c":"x",}}\n```\n以上';
    assert.deepEqual(parseJSON(raw), { a: [1, 2], b: { c: 'x' } });
    assert.throws(() => parseJSON('没有 JSON'));
});

await check('解析：<<<类型:名称|关键词>>> 分块', () => {
    const p = splitBlocks('开头\n<<<概要>>>\n他是谁\n<<<NPC:老周|周叔，管家>>>\n<老周>\n身份: 管家\n</老周>\n<<<条目:北境>>>\n冷');
    assert.equal(p.lead, '开头');
    assert.equal(blockOf(p, '概要'), '他是谁');
    assert.deepEqual(p.blocks[1], { type: 'NPC', name: '老周', keys: ['周叔', '管家'], body: '<老周>\n身份: 管家\n</老周>' });
    assert.equal(p.blocks[2].name, '北境');
    assert.deepEqual(p.blocks[2].keys, []);
});

await check('宏保护：<user>/{{user}}/{{char}} 发送前换成占位符，收到后换回', () => {
    const s = shield('<user>和{{user}}，{{ char }}看着<USER>');
    assert.equal(s, '〔user〕和〔user〕，〔char〕看着〔user〕');
    assert.equal(unshield(s), '<user>和<user>，{{char}}看着<user>');
    assert.equal(unshield('〔user〕', '{{user}}'), '{{user}}');
    assert.equal(extractTagged('前言<黎曙>\na: 1\n</黎曙>后记', '黎曙'), '<黎曙>\na: 1\n</黎曙>');
});

await check('本地质检：小动作、数字、断言、裸禁令、标签没解释', () => {
    const persona = `<黎曙>
appearance:
  overview: 身高185cm，体重70kg
对白风格:
  描述: 紧张时习惯性地推了推眼镜
他永远不会背叛<user>。
他从不撒谎，因为撒谎在扒手团会被打断手。
行为指导:
  浅层表现: [冷漠, 话少]
  深层底色:
    - 留恋
  性格解释与行为表现:
    冷漠:
      - 对外人不接话
  行为红线:
    - 不要写成依赖性强的人
    - 排除: 绝不主动示弱
      缘由: 会坍缩
      替代: 用行动表达
</黎曙>`;
    const issues = scanCard(persona, 'persona', { names: ['黎曙'] });
    const types = issues.map((i) => i.type);
    assert.ok(types.includes('action'));
    assert.ok(issues.some((i) => i.type === 'number' && i.match.includes('185')));
    assert.ok(issues.some((i) => i.type === 'assert' && i.match.includes('永远不会背叛')));
    assert.ok(!issues.some((i) => i.type === 'assert' && i.match.includes('从不撒谎')), '有缘由的断言不报');
    assert.ok(!issues.some((i) => i.type === 'assert' && i.match.includes('绝不主动示弱')), '排除行不报');
    assert.ok(issues.some((i) => i.type === 'ban' && i.match.includes('依赖性强')));
    assert.deepEqual(unexplainedLabels(persona).sort(), ['留恋', '话少']);
});

await check('本地质检：简介里的表格和超长', () => {
    const intro = '| 方向 | 线路 |\n|------|------|\n| 罪人线 | 行刑前夜 |';
    assert.ok(scanCard(intro, 'intro').some((i) => i.type === 'table'));
    assert.ok(!scanCard('> **罪人线**｜主教与异端', 'intro').some((i) => i.type === 'table'));
    assert.ok(scanCard('字'.repeat(2100), 'intro').some((i) => i.type === 'length' && i.level === 'warn'));
});

await check('本地质检：世界观形容词、高频词', () => {
    const world = '古老的城墙。神秘的森林。华丽的宫殿。昏暗的地牢。璀璨的星空。';
    assert.ok(scanCard(world, 'world').some((i) => i.type === 'adj' && i.level === 'warn'));
    assert.ok(!scanCard(world, 'world', { pistol: true }).some((i) => i.type === 'adj'));
    const text = '姐姐会照顾弟弟。姐姐是上司。姐姐也是战友。姐姐不说。姐姐看着。姐姐走开。姐姐回来。';
    assert.equal(frequentWords(text)[0].word, '姐姐');
    assert.equal(frequentWords(text, { ignore: ['姐姐'] }).length, 0);
});

await check('相似度：可预测性撞车和 NP 互相比对', () => {
    assert.ok(similarity('他会冷笑一声转身离开', '他冷笑一声，转身离开') > 0.7);
    assert.ok(similarity('他会冷笑一声转身离开', '她把账本锁进柜子') < 0.2);
    const pred = { scenes: [{ scene: '吃醋', behavior: '他会把人拉到身后宣示主权', line: '你是我的' }], traits: ['外冷内热'] };
    const card = '性格解释:\n  - 吃醋时把人拉到身后宣示主权\n  - 会记账，欠他的都写在本子上';
    const ov = predictOverlap(pred, card);
    assert.equal(ov.length, 1);
    assert.equal(ov[0].from, '吃醋·行为');
    const cc = crossCompare({ 甲: '- 吃醋时把人拉到身后宣示主权\n- 喜欢下棋', 乙: '- 吃醋时把人拉到身后宣示主权\n- 讨厌下雨' });
    assert.equal(cc.length, 1);
    assert.equal(cc[0].count, 1);
});

await check('组装：桶型结构、灯色、顺序、只开第一条路线', () => {
    const d = { ...emptyDraft(), name: '黎曙' };
    d.tone = '<创作文体>基调</创作文体>';
    d.world = { main: '<世界观>城</世界观>', extra: [{ name: '扒手团', keys: ['扒手团', '领头'], content: '<扒手团>…</扒手团>' }] };
    d.personas = [{ name: '黎曙', keys: ['阿曙'], overview: '扒手', text: '<黎曙>…</黎曙>' }];
    d.npcs = [{ name: '老周', keys: ['周叔'], content: '<老周>…</老周>' }];
    d.routes = [{ name: '孤儿时期', info: '<玩家信息>A</玩家信息>' }, { name: '重逢', info: '<玩家信息>B</玩家信息>' }];
    d.free = [{ name: '信物', content: '<信物>…</信物>', light: 'green', keys: ['怀表'], position: 'before' }, { name: '空', content: '  ' }];
    const es = buildEntries(d);
    assert.deepEqual(es.map((e) => e.comment), ['基调与规则', '世界观', '世界观·扒手团', '人设概要', '人设·黎曙', 'NPC·老周', '路线·孤儿时期', '路线·重逢', '模块·信物']);
    const by = Object.fromEntries(es.map((e) => [e.comment, e]));
    assert.equal(by['基调与规则'].position, 0);
    assert.equal(by['基调与规则'].constant, true);
    assert.equal(by['人设概要'].constant, true);
    assert.equal(by['人设·黎曙'].constant, false);
    assert.deepEqual(by['人设·黎曙'].key, ['黎曙', '阿曙']);
    assert.ok(by['人设·黎曙'].order > by['世界观'].order && by['人设·黎曙'].order > by['人设概要'].order);
    assert.equal(by['路线·孤儿时期'].disable, false);
    assert.equal(by['路线·重逢'].disable, true);
    assert.equal(by['模块·信物'].constant, false);
    assert.equal(by['模块·信物'].position, 0);
    assert.equal(buildEntries(d, { personaBlue: true }).find((e) => e.comment === '人设·黎曙').constant, true);
    const wd = toWorldData(es);
    assert.equal(Object.keys(wd.entries).length, 9);
    assert.equal(wd.entries[4].uid, 4);
    assert.equal(wd.entries[4].selective, true);
    assert.equal(wd.entries[0].addMemo, true);
});

await check('组装：角色卡请求体、开场白按路线排序、重名处理', () => {
    const d = { ...emptyDraft(), name: '黎曙', tags: [{ dim: 'cp', name: 'BG' }] };
    d.routes = [{ name: 'A' }, { name: 'B' }];
    d.greetings = [{ route: 'B', text: 'b1' }, { route: 'A', text: 'a1' }, { route: 'A', text: 'a2' }, { route: 'A', text: ' ' }];
    assert.deepEqual(orderedGreetings(d).map((g) => g.text), ['a1', 'a2', 'b1']);
    const body = buildCharacter(d, { worldName: '黎曙', creator: 'if love', intro: '简介' });
    assert.equal(body.ch_name, '黎曙');
    assert.equal(body.first_mes, 'a1');
    assert.deepEqual(body.alternate_greetings, ['a2', 'b1']);
    assert.equal(body.world, '黎曙');
    assert.equal(body.creator_notes, '简介');
    assert.deepEqual(body.tags, ['BG']);
    assert.equal(uniqueName('黎曙', ['黎曙', '黎曙 (2)']), '黎曙 (3)');
    assert.equal(uniqueName('a/b', []), 'ab');
    assert.deepEqual(mapStrings({ a: ['〔user〕'], b: 1 }, (s) => s.replace('〔user〕', '<user>')), { a: ['<user>'], b: 1 });
});

await check('简介：拼模板、去掉“无”剧透、路线写成引用行、单路线省略', () => {
    const parts = {
        题句: 'Hold me before spring ends.\n在春天结束之前抱我。',
        简介: '他第一次开口，是让你抱他。\n||无||',
        关于TA: '**黎曙**｜扒手',
        路线: '**孤儿线**｜同伙 · 试探\n**重逢线**｜仇人 · 拉扯',
        内心想法: '你要是走了，我就不追。\n反正追也追不上。',
    };
    const out = composeIntro(parts, { title: '春天结束之前', tags: [{ dim: 'cp', name: 'BG' }, { dim: 'flavor', name: '酸涩' }], author: 'if love', license: { repost: '不行哦', edit: '可', commercial: '绝对不可以' }, presetNote: '任意文风预设', charName: '黎曙' });
    assert.ok(out.startsWith('【BG|酸涩】春天结束之前'));
    assert.ok(out.includes('-# 作者：**if love**'));
    assert.ok(out.includes('-# 二传：不行哦｜二改：可｜商用：绝对不可以'));
    assert.ok(out.includes('> *Hold me before spring ends.*\n> 在春天结束之前抱我。'));
    assert.ok(!out.includes('||无||'));
    assert.ok(out.includes('> **孤儿线**｜同伙 · 试探\n> **重逢线**｜仇人 · 拉扯'));
    assert.ok(out.includes('> 反正追也追不上。\n> -# ——黎曙'));
    assert.ok(out.includes('**预设参考**：任意文风预设'));
    assert.ok(!scanCard(out, 'intro').some((i) => i.type === 'table'));
    assert.ok(!composeIntro({ ...parts, 路线: '（无）' }, {}).includes('## 路线'));
    assert.deepEqual(parseTitles('1. 《春天结束之前》\n- 标题二：他求我抱他\n\n'), ['春天结束之前', '他求我抱他']);
});

console.log(`\n${passed} passed`);
