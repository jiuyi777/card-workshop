// node tests/flow.test.mjs
// 用假的 API 跑完一整张卡：构想 → 选构想 → 问答 → 人设 → 世界观 → NPC → 路线 → 基调 → 开场白 → 可预测性 → 质检 → 简介 → 组装
import assert from 'node:assert/strict';
import { makeFlow } from '../src/flow.js';
import { buildLibrary } from '../src/tags.js';
import { emptyDraft, buildEntries, toWorldData, buildCharacter } from '../src/assemble.js';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

const lib = buildLibrary();
const settings = { greetingCount: 2, predictThreshold: 0.42, author: 'if love', license: { repost: '不行哦', edit: '可', commercial: '绝对不可以' } };
const sent = [];
const replies = [];
const flow = makeFlow({
    settings: () => settings,
    lib: () => lib,
    llm: async (o) => { sent.push(o); assert.ok(replies.length, `多出来的请求：${o.user.slice(0, 40)}`); return replies.shift(); },
});
const d = { ...emptyDraft(), idea: '“最后抱我一次吧，在春天结束之前。”……可春天已在你眼前离去了。' };

const ideaReply = JSON.stringify({
    tags: { picked: ['酸涩', '不存在'], guessed: { 性向: 'BG', 人数: '1v1', 卡类型: '单人卡' }, novel: [{ dim: '情节梗', name: '季节限定' }], surprise: { dim: '时代与题材', name: '规则怪谈', why: '循环' } },
    concepts: [
        { title: '他每年春天回来，每年都不认识我', lineup: [{ name: '迟春', identity: '只在春天存在的人', archetype: ['神明'] }], user: ['记得一切的人'], relation: '去年春末他提出请求，你犹豫了。', tension: { core: '只有你记得', expect: ['他在夏天出现', '他想起来', '你抱住他'] }, complexity: '中等', reason: '季节规则', routes: [{ name: '第一个春天', user: '初见者', period: '去年' }, { name: '失去之后', user: '等待者', period: '今年' }], npcs: 1, tags: ['仙侠', 'BE'] },
        { title: '三年前我求他抱我', lineup: [{ name: '沈既白', identity: '联姻对象', archetype: ['霸总'] }], complexity: '简单' },
    ],
    fandom: '', check: [],
});

await check('构想：本地 + AI 打标签，未知标签丢掉，推测项标问号', async () => {
    replies.push('```json\n' + ideaReply + '\n```');
    await flow.idea(d);
    assert.equal(d.concepts.length, 2);
    assert.equal(d.concepts[1].routes[0].name, '主线', '没给路线时补一条主线');
    const names = d.tags.map((t) => t.name);
    for (const n of ['酸涩', 'BG', '1v1', '单人卡', 'BE']) assert.ok(names.includes(n), n);
    assert.ok(!names.includes('不存在'));
    assert.equal(d.tagSrc['cp:BG'], 'guess');
    assert.equal(d.tagSrc['flavor:酸涩'], 'ai');
    assert.equal(d.tagSrc['plot:BE'], 'local', '“离去”是 BE 的触发词');
    assert.deepEqual(d.ai.novel, [{ dim: 'plot', name: '季节限定' }]);
    assert.equal(d.ai.surprise.name, '规则怪谈');
    assert.ok(sent[0].user.includes('角色原型：霸总'), '带上标签库');
    assert.ok(sent[0].user.includes('最后抱我一次吧'));
});

await check('选构想：带出角色、路线、复杂度、构想标签', () => {
    flow.pickConcept(d, 0);
    assert.equal(d.name, '迟春');
    assert.deepEqual(d.personas.map((p) => p.name), ['迟春']);
    assert.deepEqual(d.routes.map((r) => r.name), ['第一个春天', '失去之后']);
    assert.ok(d.tags.some((t) => t.dim === 'complexity' && t.name === '中等'));
    assert.ok(d.tags.some((t) => t.name === '仙侠') && d.tags.some((t) => t.name === '神明'));
    flow.pickConcept(d, 1);
    assert.equal(d.name, '沈既白', '名字没被手动改过时跟着换');
    flow.pickConcept(d, 0);
});

await check('问答：题目和选项', async () => {
    replies.push(JSON.stringify({ chars: [{ name: '迟春', questions: [{ q: '他为什么宁愿消失也要这个拥抱？', options: ['A', 'B', 'C'] }] }] }));
    await flow.qa(d);
    d.qa.chars[0].questions[0].answer = '拥抱是他留在人间的锚';
    assert.ok(sent.at(-1).user.includes('迟春'));
});

await check('人设：概要和 YAML 分开，作者回答进提示词，八股规则进提示词', async () => {
    replies.push('<<<概要>>>\n他是春天本身。\n<<<人设>>>\n好的\n<迟春>\n角色详情:\n  迟春:\n    矛盾轴:\n      - 轴: 想被记住 ↔ 怕连累人\n        落点: 宁可被忘\n</迟春>\n以上');
    await flow.persona(d, '迟春');
    const p = d.personas[0];
    assert.equal(p.overview, '他是春天本身。');
    assert.ok(p.text.startsWith('<迟春>') && p.text.endsWith('</迟春>'));
    const u = sent.at(-1).user;
    assert.ok(u.includes('拥抱是他留在人间的锚'));
    assert.ok(u.includes('只写特异点'));
    assert.ok(u.includes('矛盾轴'));
    assert.ok(!u.includes('{{name}}') && !u.includes('{{rules'), '变量都填上了');
    assert.equal(sent.at(-1).stage, 'card');
});

await check('世界观：总览 + 拆出来的条目；NPC 分块；路线按名字对上', async () => {
    replies.push('<世界观>\n规则: 春天结束，迟春散去\n</世界观>\n<<<条目:春祭|春祭,祭典>>>\n<春祭>…</春祭>');
    await flow.world(d);
    assert.ok(d.world.main.includes('春天结束'));
    assert.deepEqual(d.world.extra[0].keys, ['春祭', '祭典']);
    assert.ok(sent.at(-1).user.includes('零度写作') || sent.at(-1).user.includes('白描'));

    replies.push('<<<NPC:守庙人|老庙祝>>>\n<守庙人>\n功能: 提供信息\n</守庙人>');
    await flow.npc(d);
    assert.deepEqual(d.npcs.map((n) => n.name), ['守庙人']);

    replies.push('<<<路线:失去之后>>>\n<玩家信息>B</玩家信息>\n<<<路线:第一个春天>>>\n<玩家信息>A</玩家信息>');
    await flow.routes(d);
    assert.ok(d.routes[0].info.includes('A') && d.routes[1].info.includes('B'));
});

await check('基调：只取 <创作文体>；开场白走开场白阶段，按路线替换', async () => {
    replies.push('说明\n<创作文体>\n基石: 奇幻\n</创作文体>');
    await flow.tone(d);
    assert.equal(d.tone, '<创作文体>\n基石: 奇幻\n</创作文体>');

    replies.push('<<<开场白>>>\n第一段\n<<<开场白>>>\n第二段');
    await flow.greetings(d, 0);
    assert.equal(sent.at(-1).stage, 'greeting');
    assert.ok(sent.at(-1).user.includes('共 2 个'));
    replies.push('只有一段，没有分隔');
    await flow.greetings(d, 1, 1);
    replies.push('<<<开场白>>>\n重写的第一条');
    await flow.greetings(d, 0, 1);
    assert.deepEqual(d.greetings.map((g) => [g.route, g.text]), [['失去之后', '只有一段，没有分隔'], ['第一个春天', '重写的第一条']]);
});

await check('可预测性：撞车的句子被找出来，重写后复查', async () => {
    d.personas[0].text = '<迟春>\n性格解释:\n  - 吃醋时把人拉到身后宣示主权\n  - 每年春天第一天去旧桥下等人\n</迟春>';
    replies.push(JSON.stringify({ scenes: [{ scene: '吃醋', behavior: '他会把人拉到身后宣示主权', line: '你是我的' }], traits: ['外冷内热'] }));
    const r = await flow.predict(d, '迟春');
    assert.equal(r.overlaps.length, 1);
    assert.ok(!sent.at(-1).user.includes('旧桥'), '预测时不能看到卡的内容');
    replies.push('<迟春>\n性格解释:\n  - 吃醋时不说话，把对方送他的东西还回去\n</迟春>');
    await flow.destale(d, '迟春');
    assert.ok(sent.at(-1).user.includes('宣示主权'));
    assert.equal(d.predict['迟春'].overlaps.length, 0);
});

await check('本地质检和文本位置', () => {
    d.npcs[0].content += '\n他永远不会说谎。';
    const r = flow.localCheck(d);
    assert.ok(r.sections.some((s) => s.label === 'NPC·守庙人' && s.issues.some((i) => i.type === 'assert')));
    const slots = flow.textSlots(d);
    assert.ok(slots.some((s) => s.label === '人设·迟春'));
    slots.find((s) => s.label === '基调与规则').set('新基调');
    assert.equal(d.tone, '新基调');
});

await check('自定义步骤：模板变量可用，产出变成自由模块', async () => {
    replies.push('<信物>\n名称: 旧怀表\n</信物>');
    await flow.custom(d, { id: 'c1', name: '信物', template: '给{{concept}}写信物，规则：{{rules.通用}}，玩家{{user}}', light: 'green', keys: ['怀表'] });
    const u = sent.at(-1).user;
    assert.ok(u.includes('标题：他每年春天回来') && u.includes('只写特异点') && u.includes('{{user}}'));
    assert.equal(d.free[0].name, '信物');
    assert.equal(d.free[0].light, 'green');
    replies.push('改过的信物');
    await flow.custom(d, { id: 'c1', name: '信物', template: 'x' });
    assert.equal(d.free.length, 1, '同一步骤再跑覆盖原模块');
});

await check('简介：三个标题，按模板拼好', async () => {
    replies.push('<<<标题>>>\n1. 他每年春天回来，每年都不认识我\n2. 春天结束之前\n3. “最后抱我一次”\n<<<题句>>>\nHold me before spring ends.\n在春天结束之前抱我。\n<<<简介>>>\n桥下站着一个人。\n||无||\n<<<关于TA>>>\n**迟春**｜春天\n<<<路线>>>\n**第一个春天**｜初见 · 试探\n**失去之后**｜等待 · 酸涩\n<<<内心想法>>>\n这次别犹豫了。');
    await flow.intro(d);
    assert.equal(d.intro.titles.length, 3);
    assert.ok(d.intro.text.startsWith('【BG|1v1|仙侠|酸涩'));
    assert.ok(d.intro.text.includes('他每年春天回来，每年都不认识我'));
    assert.ok(d.intro.text.includes('-# 作者：**if love**'));
    d.intro.pick = 1;
    assert.ok(flow.composeIntroFor(d).includes('】春天结束之前'));
});

await check('组装：世界书条目和角色卡', () => {
    const es = buildEntries(d);
    const comments = es.map((e) => e.comment);
    for (const c of ['基调与规则', '世界观', '世界观·春祭', '人设概要', '人设·迟春', 'NPC·守庙人', '路线·第一个春天', '路线·失去之后', '模块·信物']) assert.ok(comments.includes(c), c);
    const wd = toWorldData(es);
    assert.equal(Object.keys(wd.entries).length, es.length);
    const body = buildCharacter(d, { worldName: '迟春' });
    assert.equal(body.first_mes, '重写的第一条');
    assert.deepEqual(body.alternate_greetings, ['只有一段，没有分隔']);
});

await check('灵感：掷骰子出问题，锁定的骰子不变，回答拼成一句话脑洞', async () => {
    const e = { ...emptyDraft(), diceLock: { relation: '宿敌' } };
    replies.push(JSON.stringify({ questions: [{ q: '谁欠了谁？', options: ['他欠她一条命', '她欠他一个解释', '两清了'] }, { q: '故事从哪一刻开始？', options: ['婚礼上', '刑场上', '雨夜'] }] }));
    await flow.inspire(e);
    assert.equal(e.dice.relation, '宿敌');
    assert.ok(sent.at(-1).user.includes('关系结构：宿敌'));
    assert.equal(e.inspire.length, 2);
    e.inspire[0].answer = '她欠他一个解释';
    e.inspire[1].answer = '刑场上';
    flow.ideaFromInspire(e);
    assert.ok(e.idea.startsWith('她欠他一个解释；刑场上'));
    assert.ok(e.idea.includes('宿敌'));
});

assert.equal(replies.length, 0);
console.log(`\n${passed} passed`);
