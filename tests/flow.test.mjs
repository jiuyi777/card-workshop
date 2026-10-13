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
    replies.push('<<<概要>>>\n他是极其安静的春天本身。\n<<<人设>>>\n好的\n<迟春>\n角色详情:\n  迟春:\n    矛盾轴:\n      - 轴: 想被记住 ↔ 怕连累人\n        落点: 宁可被忘\n</迟春>\n以上');
    await flow.persona(d, '迟春');
    const p = d.personas[0];
    assert.equal(p.overview, '他是安静的春天本身。', '程度副词直接删掉');
    assert.ok(p.text.startsWith('<迟春>') && p.text.endsWith('</迟春>'));
    const u = sent.at(-1).user;
    assert.ok(u.includes('拥抱是他留在人间的锚'));
    assert.ok(u.includes('只写特异点'));
    assert.ok(u.includes('矛盾轴'));
    assert.ok(!u.includes('{{name}}') && !u.includes('{{rules'), '变量都填上了');
    assert.ok(sent.at(-1).system.includes('一律不要出现') && sent.at(-1).system.includes('占有欲'), '禁用词进了系统提示');
    settings.rules = { 禁用词: '神明\n占有欲' };
    assert.deepEqual(flow.banned(d), ['占有欲'], '选了“神明”标签就不禁这个词');
    settings.rules = {};
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
    replies.push(JSON.stringify({ overlaps: [{ card: '吃醋时把人拉到身后宣示主权', stereotype: '他会把人拉到身后宣示主权', why: '一模一样' }, { card: '每年春天第一天去旧桥下等人', stereotype: '外冷内热', why: '默默守候' }] }));
    const r = await flow.predict(d, '迟春');
    assert.ok(!sent.at(-2).user.includes('旧桥'), '第一次预测时看不到卡的内容');
    assert.ok(sent.at(-1).user.includes('旧桥') && sent.at(-1).user.includes('外冷内热'), '第二次按意思比对');
    assert.equal(r.overlaps.length, 2, 'AI 比对出 2 条，本地那条和它重复不再算');
    assert.equal(r.overlaps[0].from, 'AI 比对');
    replies.push('<迟春>\n性格解释:\n  - 吃醋时不说话，把对方送他的东西还回去\n</迟春>');
    await flow.destale(d, '迟春');
    assert.ok(sent.at(-1).user.includes('宣示主权'));
    assert.equal(d.predict['迟春'].overlaps.length, 0);
    assert.equal(d.predict['迟春'].rewritten, true);
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
    for (const c of ['基调与规则', '世界观', '世界观·春祭', '人设·迟春', 'NPC·守庙人', '路线·第一个春天', '路线·失去之后', '模块·信物']) assert.ok(comments.includes(c), c);
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

await check('修改意见：重写时带上意见和上一版，用完清空', async () => {
    d.feedback = { tone: '太温吞了，冲突再尖锐一点' };
    replies.push('<创作文体>\n基石: 尖锐\n</创作文体>');
    await flow.tone(d);
    const u = sent.at(-1).user;
    assert.ok(u.includes('【作者对上一版的修改意见，必须优先满足】\n太温吞了') && u.includes('【上一版】'), '意见和上一版都发了');
    assert.equal(d.feedback.tone, '');
    assert.ok(d.tone.includes('尖锐'));
});

await check('上一版：可以换回去，再点一次又换回来', () => {
    const before = d.tone;
    assert.ok(d.history.tone.length >= 1);
    assert.ok(flow.restore(d, 'tone'));
    assert.notEqual(d.tone, before);
    assert.ok(flow.restore(d, 'tone'));
    const seen = new Set([d.tone]);
    for (let i = 0; i < d.history.tone.length; i++) { flow.restore(d, 'tone'); seen.add(d.tone); }
    assert.ok(seen.has(before), '轮换一圈能回到最新版');
    assert.equal(flow.restore(d, 'nothing'), false);
});

await check('上一版：人设、开场白也能换回', async () => {
    const old = d.personas[0].text;
    replies.push('<<<概要>>>\n新概要\n<<<人设>>>\n<迟春>\n新人设\n</迟春>');
    await flow.persona(d, '迟春');
    assert.ok(d.personas[0].text.includes('新人设'));
    flow.restore(d, 'persona:迟春');
    assert.equal(d.personas[0].text, old);
    const g = d.greetings.filter((x) => x.route === '第一个春天').map((x) => x.text);
    replies.push('<<<开场白>>>\n新开场');
    await flow.greetings(d, 0, 1);
    flow.restore(d, 'greet:第一个春天');
    assert.deepEqual(d.greetings.filter((x) => x.route === '第一个春天').map((x) => x.text), g);
});

await check('截断：没有收尾标签就自动续写一次；还不完整就标记', async () => {
    replies.push('<世界观>\n势力:\n  春神庙: 想留住');
    replies.push('迟春\n</世界观>');
    await flow.world(d);
    assert.ok(sent.at(-1).user.includes('从断掉的地方直接接着写'));
    assert.ok(d.world.main.includes('想留住迟春') && d.world.main.includes('</世界观>'), d.world.main);
    assert.ok(!d.truncated.world);
    replies.push('<世界观>\n写到一半');
    replies.push('还是没写完');
    await flow.world(d);
    assert.equal(d.truncated.world, true);
    flow.restore(d, 'world');
    assert.ok(!d.truncated.world, '换回上一版后去掉截断提醒');
});

await check('脑洞问答：有脑洞也能先问问题，回答带进构想', async () => {
    const e = { ...emptyDraft(), idea: '铁血权相与废柴义子' };
    replies.push(JSON.stringify({ questions: [{ q: '义子真的废吗？', options: ['装的', '真废', '半废'] }] }));
    await flow.ideaQA(e);
    assert.ok(sent.at(-1).user.includes('铁血权相与废柴义子') && sent.at(-1).user.includes('脑洞里已经写明的不要再问'));
    e.ideaQA[0].answer = '装的';
    replies.push(ideaReply);
    await flow.idea(e);
    assert.ok(sent.at(-1).user.includes('【作者补充】\n义子真的废吗？\n→ 装的'));
});

await check('开场白：先想梗，勾选/自己写，再扩写，扩写的加在后面不覆盖', async () => {
    const before = d.greetings.filter((g) => g.route === '第一个春天').length;
    replies.push(JSON.stringify({ hooks: ['庙门口，他极其安静地等着', '雨夜桥下', '春祭当天', '夏天他出现了', '他认出了你'] }));
    await flow.hooks(d, 0);
    assert.equal(sent.at(-1).stage, 'greeting', '想梗用开场白预设');
    assert.equal(d.hooks['第一个春天'].length, 5);
    assert.equal(d.hooks['第一个春天'][0].text, '庙门口，他安静地等着', '梗也删程度副词');
    d.hooks['第一个春天'][1].on = true;
    d.hooks['第一个春天'].push({ text: '我自己写的梗', on: true, mine: true });
    replies.push(JSON.stringify({ hooks: ['新梗1', '新梗2', '新梗3', '新梗4', '新梗5'] }));
    await flow.hooks(d, 0);
    const hs = d.hooks['第一个春天'];
    assert.equal(hs.length, 7, '勾了的和自己写的留着，没勾的换掉');
    assert.ok(sent.at(-1).user.includes('雨夜桥下'), '已有的梗告诉 AI 别重复');
    replies.push('<<<开场白>>>\n雨夜桥下的正文\n<<<开场白>>>\n自己写的梗的正文');
    const n = await flow.expand(d, 0);
    assert.equal(n, 2);
    assert.ok(sent.at(-1).user.includes('1. 雨夜桥下\n2. 我自己写的梗'));
    const after = d.greetings.filter((g) => g.route === '第一个春天');
    assert.equal(after.length, before + 2);
    assert.ok(hs.filter((h) => h.used).length === 2 && !hs.some((h) => h.on));
    await assert.rejects(() => flow.expand(d, 0), /先勾选/);
});

await check('我的步骤：重写带意见、存上一版', async () => {
    const st = { id: 'c1', name: '信物', template: '写信物' };
    d.feedback['free:信物'] = '再神秘一点';
    replies.push('更神秘的信物');
    await flow.custom(d, st);
    assert.ok(sent.at(-1).user.includes('再神秘一点') && sent.at(-1).user.includes('【上一版】'));
    assert.equal(d.free.find((f) => f.fromStep === 'c1').content, '更神秘的信物');
    flow.restore(d, 'free:信物');
    assert.equal(d.free.find((f) => f.fromStep === 'c1').content, '改过的信物');
});

await check('简介风格：换风格只重排，不调 API；条件块和过滤器', async () => {
    const { renderIntro, DEFAULT_INTRO_STYLE } = await import('../src/assemble.js');
    assert.equal(renderIntro('{{#路线}}## 路线\n{{路线|引用}}{{/路线}}标题：{{标题}}', { 路线: '', 标题: 'T' }), '标题：T');
    assert.equal(renderIntro('{{#路线}}{{路线|引用}}{{/路线}}', { 路线: 'a\nb' }), '> a\n> b');
    assert.equal(renderIntro('{{#a}}A{{#b}}B{{/b}}{{/a}}', { a: '1', b: '' }), 'A');
    const n0 = sent.length;
    settings.introStyles = [{ name: '极简', tpl: '{{标题}}\n\n{{简介}}' }];
    settings.introStyle = 1;
    const text = flow.composeIntroFor(d);
    assert.equal(sent.length, n0);
    assert.ok(text.startsWith(d.intro.titles[d.intro.pick]) && !text.includes('关于TA'), text);
    settings.introStyle = 0;
    assert.ok(flow.composeIntroFor(d).includes('## 关于TA'));
    assert.ok(DEFAULT_INTRO_STYLE.includes('{{#内心想法}}'));
});

await check('八股清理跳过基调与规则（规则清单本身列着禁用词）', () => {
    const slots = flow.textSlots(d);
    assert.equal(slots.find((x) => x.label === '基调与规则').rules, true);
    assert.ok(!slots.find((x) => x.label === '世界观').rules);
});

await check('改已有的卡：读进来，按意见改，想新路线，只写新路线，写回时合并', async () => {
    const { cardUpdate, mergeWorld } = await import('../src/assemble.js');
    const card = { avatar: '黎曙.png', data: { name: '黎曙', description: '他是扒手团的孤儿。', personality: '冷', scenario: '', first_mes: '原开场', alternate_greetings: ['原开场2'], tags: ['BG', '扒手/盗贼', '奇怪标签'] } };
    const world = { entries: {
        0: { uid: 0, comment: '扒手团', key: ['扒手团'], content: '领头叫老鬼', constant: false, disable: false },
        1: { uid: 1, comment: '路线·孤儿时期', key: [], content: '<玩家信息>A</玩家信息>', constant: true, disable: false },
    } };
    const e = flow.loadCard(card, world, '黎曙');
    assert.equal(e.personas[0].fromDescription, true, '没有人设条目时，角色描述就是人设');
    assert.equal(e.personas[0].text, '他是扒手团的孤儿。');
    assert.deepEqual(e.tags.map((t) => t.name), ['BG', '扒手/盗贼'], '只认标签库里有的');
    assert.deepEqual(e.routes.map((r) => r.name), ['孤儿时期']);
    assert.equal(e.existing.entries.length, 1);
    assert.deepEqual(e.existing.greetings, ['原开场', '原开场2']);

    // 按意见改原卡的条目
    e.feedback['exist:entry:0'] = '领头改成女的';
    replies.push('领头叫鬼姐');
    await flow.revise(e, 'exist:entry:0');
    assert.ok(sent.at(-1).user.includes('领头改成女的') && sent.at(-1).user.includes('领头叫老鬼') && sent.at(-1).user.includes('卡名：黎曙'), '原文、意见、原卡摘要都发了');
    assert.equal(e.existing.entries[0].content, '领头叫鬼姐');
    flow.restore(e, 'exist:entry:0');
    assert.equal(e.existing.entries[0].content, '领头叫老鬼');
    await assert.rejects(() => flow.revise(e, 'exist:entry:0'), /先在/);

    // 想新路线，加一条，只写新的那条
    replies.push(JSON.stringify({ routes: [{ name: '重逢', user: '仇人', period: '十年后', why: '他欠你一条命' }, { name: '孤儿时期', user: 'x', period: 'y', why: 'z' }] }));
    await flow.suggestRoutes(e);
    assert.ok(sent.at(-1).user.includes('孤儿时期'), '告诉 AI 已有路线');
    flow.addRouteIdea(e, 1);
    assert.equal(e.routes[1].name, '孤儿时期2', '重名自动加序号');
    flow.addRouteIdea(e, 0);
    replies.push('<<<路线:孤儿时期2>>>\n<玩家信息>B</玩家信息>\n<<<路线:重逢>>>\n<玩家信息>C</玩家信息>');
    await flow.routes(e);
    assert.ok(sent.at(-1).user.includes('【已有的路线】') && !/\d\. 孤儿时期｜/.test(sent.at(-1).user), '只写新路线，原路线作参考');
    assert.equal(e.routes[0].info, '<玩家信息>A</玩家信息>', '原路线没动');
    assert.ok(e.routes[2].info.includes('C'));

    // 写回：原条目按 uid 改，写卡工坊的条目按名字找，没有就新建；新路线默认关
    e.existing.entries[0].content = '改过的扒手团';
    e.greetings = [{ route: '重逢', text: '新开场' }];
    const merged = mergeWorld(world, e);
    const by = Object.fromEntries(Object.values(merged.entries).map((x) => [x.comment, x]));
    assert.equal(by['扒手团'].content, '改过的扒手团');
    assert.equal(by['路线·孤儿时期'].disable, false);
    assert.equal(by['路线·重逢'].disable, true, '已经有开着的路线，新路线默认关');
    assert.ok(!by['人设·黎曙'], '人设在角色描述里，不进世界书');
    assert.equal(Object.keys(merged.entries).length, 4);
    assert.equal(world.entries[0].content, '领头叫老鬼', '不改传进来的原数据');
    e.personas[0].text = '改过的人设';
    const up = cardUpdate(e);
    assert.equal(up.description, '改过的人设');
    assert.equal(up.first_mes, '原开场');
    assert.deepEqual(up.alternate_greetings, ['原开场2', '新开场'], '新开场白加在后面');
});

await check('改已有的卡：写卡工坊做的卡能认回各个步骤；没绑世界书时读卡里嵌的', async () => {
    const { buildEntries, toWorldData, worldToBook } = await import('../src/assemble.js');
    const made = toWorldData(buildEntries(d, { personaPlace: 'green' }));
    const e = flow.loadCard({ avatar: 'a.png', data: { name: '迟春', description: '' } }, made, '迟春');
    assert.equal(e.tone, d.tone);
    assert.equal(e.world.main, d.world.main);
    assert.deepEqual(e.personas.map((p) => p.name), d.personas.map((p) => p.name));
    assert.equal(e.personas[0].overview, d.personas[0].overview, '概要从“人设概要”条目认回来');
    assert.deepEqual(e.npcs.map((n) => n.name), d.npcs.map((n) => n.name));
    assert.deepEqual(e.routes.map((r) => r.name), d.routes.map((r) => r.name));
    assert.equal(e.existing.entries.length, 0);
    const e2 = flow.loadCard({ avatar: 'b.png', data: { name: '迟春', character_book: worldToBook('x', made) } }, null, '');
    assert.equal(e2.tone, d.tone, '嵌在卡里的世界书也能读');
    assert.equal(e2.existing.hadWorld, false);
});

assert.equal(replies.length, 0);
console.log(`\n${passed} passed`);
