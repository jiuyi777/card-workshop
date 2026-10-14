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
    llm: async (o) => { sent.push(o); assert.ok(replies.length, `多出来的请求：${String(o.user ?? o.messages?.at(-1)?.content).slice(0, 40)}`); return replies.shift(); },
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
    const ch = d.changes['persona:迟春'];
    assert.ok(ch.how.includes('撞车'));
    assert.ok(ch.hunks.some((h) => h.before.includes('宣示主权') && h.after.includes('还回去')), '记下原来 → 现在');
    assert.equal(d.predict['迟春'].fixed.length, 2);
    assert.ok(d.history['persona:迟春'].length, '能换回去');
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

await check('每一页的八股检查：每块文字都知道自己在哪一页；梗和简介只在单页检查里算', () => {
    const slots = flow.textSlots(d);
    assert.equal(slots.find((x) => x.label === '世界观').page, 'world');
    assert.ok(slots.filter((x) => x.label.startsWith('人设')).every((x) => x.page === 'persona'));
    assert.ok(slots.filter((x) => x.label.startsWith('开场白')).every((x) => x.page === 'greet'));
    assert.equal(slots.find((x) => x.label === '模块·信物').page, 'step:c1');
    assert.ok(!slots.some((x) => x.label.startsWith('梗·') || x.label.startsWith('简介')));
    const all = flow.textSlots(d, { all: true });
    assert.ok(all.some((x) => x.label.startsWith('梗·') && x.page === 'greet'));
    const intro = all.filter((x) => x.page === 'intro');
    assert.ok(intro.length && intro.every((x) => x.introPart));
    intro[0].set('改过');
    assert.equal(Object.values(d.intro.parts)[0] === '改过' || Object.values(d.intro.parts).includes('改过'), true);
});

await check('单独写一个 NPC：带上名字和设想、别的 NPC，只改这一个', async () => {
    const before = d.npcs.map((n) => n.content);
    d.npcs.push({ name: '', desc: '宫里的老太医，知道母蛊的来历', keys: [], content: '' });
    const i = d.npcs.length - 1;
    replies.push('<<<NPC:秦太医|太医,老秦>>>\n<秦太医>\n身份: 太医\n功能: 提供信息\n</秦太医>');
    const n = await flow.npcOne(d, i);
    assert.equal(n.name, '秦太医', '名字空着用 AI 起的');
    assert.deepEqual(n.keys, ['太医', '老秦']);
    assert.ok(n.content.includes('提供信息'));
    const u = sent.at(-1).user;
    assert.ok(u.includes('宫里的老太医') && u.includes('（你来起）'));
    assert.ok(u.includes(d.npcs[0].name), '带上已有的 NPC');
    assert.deepEqual(d.npcs.slice(0, i).map((x) => x.content), before, '别的不动');
    replies.push('<<<NPC:别的名字|x>>>\n<秦太医>\n身份: 太医\n功能: 制造阻碍\n</秦太医>');
    await flow.npcOne(d, i);
    assert.equal(d.npcs[i].name, '秦太医', '已经有名字就不换');
    assert.ok(d.changes.npc.hunks.some((h) => h.after.includes('制造阻碍')), '重写时显示改了什么');
    flow.restore(d, 'npc');
    assert.ok(d.npcs[i].content.includes('提供信息'), '换回上一版');
    d.npcs.splice(i, 1);
});

await check('新加一个主要角色：写设想、名字空着让 AI 起；参考已有角色；能写进人设条目', async () => {
    const e = { ...emptyDraft(), name: '勇者和魔王', personas: [{ name: '魔王', keys: [], overview: '魔王，想退休', text: '<魔王>x</魔王>' }, { name: '', desc: '勇者的师父，其实是上一任魔王', keys: [], overview: '', text: '' }] };
    replies.push('<<<名字>>>\n老塞\n<<<概要>>>\n〔新角色〕是勇者的师父。\n<<<人设>>>\n<〔新角色〕>\n身份: 上一任魔王\n</〔新角色〕>');
    await flow.persona(e, 1);
    const u = sent.at(-1).user;
    assert.ok(u.includes('勇者的师父，其实是上一任魔王') && u.includes('<<<名字>>>'), '带上设想，让 AI 起名');
    assert.ok(u.includes('魔王：魔王，想退休'), '参考已有角色');
    const p = e.personas[1];
    assert.equal(p.name, '老塞');
    assert.equal(p.overview, '老塞是勇者的师父。');
    assert.equal(p.text, '<老塞>\n身份: 上一任魔王\n</老塞>');
    const { buildEntries } = await import('../src/assemble.js');
    assert.ok(buildEntries(e).some((x) => x.comment === '人设·老塞'));
    // 有名字但没设想、也没构想身份：告诉 AI 这是新加的角色
    e.personas.push({ name: '公主', keys: [], overview: '', text: '' });
    replies.push('<<<概要>>>\n公主。\n<<<人设>>>\n<公主>\ny\n</公主>');
    await flow.persona(e, '公主');
    assert.ok(sent.at(-1).user.includes('这是新加进来的角色'));
});

await check('卡的类型：标签和人数自动判断，作者选的优先', () => {
    const m = (tags, extra = {}) => flow.modeOf({ ...emptyDraft(), tags, ...extra });
    assert.equal(m([]), 'single');
    assert.equal(m([{ dim: 'count', name: 'NP' }]), 'multi');
    assert.equal(m([{ dim: 'count', name: '群像' }]), 'multi');
    assert.equal(m([{ dim: 'cardType', name: '世界卡' }]), 'world');
    assert.equal(m([], { personas: [{ name: 'a' }, { name: 'b' }] }), 'multi');
    assert.equal(m([{ dim: 'count', name: 'NP' }], { mode: 'single' }), 'single', '作者选的优先');
});

await check('规则库可插拔：关掉、插到别的步骤、只给某种卡用、自己加；人设模板能换', async () => {
    const saved = JSON.stringify({ rules: settings.rules, customRules: settings.customRules, ruleOff: settings.ruleOff, ruleModes: settings.ruleModes, ruleSteps: settings.ruleSteps });
    const e = { ...emptyDraft(), name: '测试', personas: [{ name: '甲', keys: [], overview: '', text: '' }] };
    // 改过又改回默认（存成空）时用默认，不是空
    settings.rules = { 通用: '' };
    // 自己加一条，插到世界观
    settings.customRules = { 宫斗写法: '宫斗：每个势力背后都有一位娘娘。' };
    settings.ruleSteps = { 宫斗写法: ['world'] };
    replies.push('<世界观>\n概述: x\n</世界观>');
    await flow.world(e);
    assert.ok(sent.at(-1).user.includes('【规则·宫斗写法】') && sent.at(-1).user.includes('每个势力背后都有一位娘娘'));
    // 关掉通用，换人设模板
    settings.ruleOff = { 通用: true };
    settings.rules = { 人设模板: '我的模板:\n  {{name}}:\n    核心: …' };
    replies.push('<<<概要>>>\n甲。\n<<<人设>>>\n<甲>\n我的模板:\n</甲>');
    await flow.persona(e, '甲');
    let u = sent.at(-1).user;
    assert.ok(u.includes('我的模板:\n  甲:'), '用自己的人设模板，{{name}} 换成名字');
    assert.ok(!u.includes('只写特异点'), '关掉的规则不出现');
    assert.ok(!u.includes('【规则·多人卡】'), '单人卡不带多人卡规则');
    // 多人卡：多人卡规则自动插进人设
    settings.ruleOff = {};
    e.mode = 'multi';
    replies.push('<<<概要>>>\n甲。\n<<<人设>>>\n<甲>\nx\n</甲>');
    await flow.persona(e, '甲');
    u = sent.at(-1).user;
    assert.ok(u.includes('【规则·多人卡】') && u.includes('只写特异点'));
    // 限定只给世界卡用：多人卡里就没有了
    settings.ruleModes = { 宫斗写法: 'world' };
    replies.push('<世界观>\n概述: x\n</世界观>');
    await flow.world(e);
    assert.ok(!sent.at(-1).user.includes('宫斗写法'));
    const list = flow.ruleList();
    assert.ok(list.find((r) => r.name === '宫斗写法' && !r.builtin));
    assert.ok(list.find((r) => r.name === '人设模板' && r.builtin && r.edited));
    Object.assign(settings, JSON.parse(saved));
});

await check('多人卡：角色关系网（常驻，在人设后面），能读回来；世界卡：NPC 至少 6 个', async () => {
    const { buildEntries, toWorldData, cardToDraft } = await import('../src/assemble.js');
    const e = { ...emptyDraft(), name: '三人行', mode: 'multi', personas: [{ name: '甲', keys: [], overview: '甲的概要', text: '<甲>x</甲>' }, { name: '乙', keys: [], overview: '乙的概要', text: '<乙>y</乙>' }] };
    replies.push('<角色关系>\n关系:\n  甲 与 乙: 旧仇\n出场规则:\n  - 甲先开口\n</角色关系>');
    await flow.relations(e);
    assert.ok(e.relations.includes('旧仇'));
    assert.ok(sent.at(-1).user.includes('甲的概要') && sent.at(-1).user.includes('乙的概要'));
    const es = buildEntries(e);
    const i = es.findIndex((x) => x.comment === '角色关系');
    assert.ok(i > es.findIndex((x) => x.comment === '人设·乙') && es[i].constant);
    const back = cardToDraft({ avatar: 'a.png', data: { name: '三人行', description: '' } }, toWorldData(es), '三人行');
    assert.equal(back.relations, e.relations);
    await assert.rejects(() => flow.relations({ ...emptyDraft(), personas: [{ name: '甲' }] }), /两个主要角色/);
    e.routes = [{ name: '囚禁后', user: '', period: '', info: '' }];
    replies.push('<<<路线:囚禁后>>>\n<玩家信息>x</玩家信息>');
    await flow.routes(e);
    const ru = sent.at(-1).user;
    assert.ok(ru.includes('〔user〕和甲的关系：') && ru.includes('〔user〕和乙的过去：'), '每个主要角色都要写');
    assert.ok(ru.includes('和甲、乙各自的关系') && !ru.includes('〔user〕和主要角色的关系'), '用名字，不写“主要角色”');
    const w = { ...emptyDraft(), name: '王都', mode: 'world', concepts: [{ title: '王都', lineup: [], npcs: 2, routes: [] }], pick: 0 };
    replies.push('<<<NPC:甲|>>>\n<甲>\n功能: x\n</甲>');
    await flow.npc(w);
    assert.ok(sent.at(-1).user.includes('6 个左右'), '世界卡 NPC 至少 6 个');
    assert.ok(sent.at(-1).user.includes('【规则·世界卡】'));
});

await check('改了什么：按行比较，只列改动的地方', async () => {
    const { diffLines } = await import('../src/diff.js');
    assert.deepEqual(diffLines('a\nb\nc', 'a\nb\nc'), []);
    assert.deepEqual(diffLines('a\nb\nc\nd', 'a\nB\nc\nd'), [{ before: 'b', after: 'B' }]);
    assert.deepEqual(diffLines('a\nc', 'a\nb\nc'), [{ before: '', after: 'b' }]);
    assert.deepEqual(diffLines('a\nb\nc', 'a\nc'), [{ before: 'b', after: '' }]);
    assert.equal(diffLines('x\n  y', 'x\ny ').length, 0, '只差空白不算');
});

await check('局部重写：只改选中的那段，缩进和前后原样；文风只加在人设类步骤', async () => {
    const p = d.personas[0];
    p.text = '<迟春>\n性格:\n  - 他很温柔\n  - 每年春天去旧桥\n</迟春>';
    const start = p.text.indexOf('  - 他很温柔');
    const end = start + '  - 他很温柔'.length;
    settings.styles = [{ name: '冷', text: '短句，不用形容词' }];
    d.style = 1;
    replies.push('【【他对谁都客气，只对〔user〕说重话】】');
    const r = await flow.localEdit(d, { path: 'personas.0.text', start, end, instruction: '改成嘴硬', key: 'persona:迟春', label: '人设·迟春' });
    assert.equal(p.text, '<迟春>\n性格:\n  - 他对谁都客气，只对〔user〕说重话\n  - 每年春天去旧桥\n</迟春>', 'AI 丢了列表符号也补回来');
    assert.ok(r.after.startsWith('  '), '保留缩进');
    const u = sent.at(-1).user;
    assert.ok(u.includes('【【  - 他很温柔】】') && u.includes('改成嘴硬'));
    assert.ok(u.includes('【文风】') && u.includes('短句，不用形容词'), '人设带文风');
    assert.deepEqual(d.changes['persona:迟春'].hunks, [{ before: '- 他很温柔', after: '- 他对谁都客气，只对〔user〕说重话' }]);
    flow.restore(d, 'persona:迟春');
    assert.ok(p.text.includes('他很温柔'), '换回上一版');
    await assert.rejects(() => flow.localEdit(d, { path: 'personas.0.text', start: 3, end: 3 }), /先在框里选中/);
    p.text = 'appearance:\n  overview: 身形挺拔却清瘦。\n  attire: 红色吉服\n';
    const s2 = p.text.indexOf('  overview');
    replies.push('瘦，站着时总往门边靠。');
    await flow.localEdit(d, { path: 'personas.0.text', start: s2, end: p.text.indexOf('\n  attire') + 1 });
    assert.equal(p.text, 'appearance:\n  overview: 瘦，站着时总往门边靠。\n  attire: 红色吉服\n', 'YAML 键名和换行补回来');
    // 世界观默认不带文风，勾了“其他也用”才带
    assert.equal(flow.styleOf(d, 'world'), '');
    assert.equal(flow.styleOf(d, 'persona'), '短句，不用形容词');
    assert.equal(flow.styleOf(d, 'revise', 'persona:迟春'), '短句，不用形容词');
    d.styleAll = true;
    assert.equal(flow.styleOf(d, 'world'), '短句，不用形容词');
    assert.equal(flow.styleOf(d, 'predict'), '', '测试类步骤永远不带');
    d.style = 0; d.styleAll = false;
});

await check('试玩：从开场白开始，发出去的设定和导入后一样，多轮对话，AI 扮 user，点评能指到页面', async () => {
    const { sentContext } = await import('../src/assemble.js');
    const gs = flow.playGreetings(d);
    assert.ok(gs.length >= 2 && gs[0].route);
    flow.playStart(d, 1);
    assert.equal(d.play.messages.length, 1);
    assert.equal(d.play.route, gs[1].route);
    await assert.rejects(() => flow.playChar(d), /先写一句/);
    d.play.messages.push({ role: 'user', text: '<user>看着{{char}}：你是谁？' });
    d.play.userName = '林夏';
    replies.push('他没回答。');
    await flow.playChar(d);
    const o = sent.at(-1);
    assert.equal(o.stage, 'greeting', '用开场白预设');
    assert.deepEqual(o.messages.map((m) => m.role), ['assistant', 'user'], '开场白是角色说的');
    assert.ok(o.messages[1].content.includes('林夏看着迟春'), '名字替换');
    assert.ok(o.system.includes(d.tone.trim().slice(0, 10)), '带上基调');
    const ri = d.routes.findIndex((r) => r.name === d.play.route);
    const other = d.routes.find((_, i) => i !== ri);
    assert.ok(o.system.includes(d.routes[ri].info.trim().slice(0, 12)), '带上这条路线');
    if (other?.info && other.info !== d.routes[ri].info) assert.ok(!o.system.includes(other.info.trim()), '不带别的路线');
    assert.equal(d.play.messages.at(-1).text, '他没回答。');
    // NPC 是绿灯：提到名字才发
    const npc = d.npcs[0];
    assert.ok(!sentContext(d, { activeRoute: ri, scan: '没提到' }).after.some((x) => x.label === `NPC·${npc.name}`));
    assert.ok(sentContext(d, { activeRoute: ri, scan: `去找${npc.name}` }).after.some((x) => x.label === `NPC·${npc.name}`));
    // AI 扮 user 跑两轮
    d.play.style = '唱反调';
    replies.push('（后退一步）我不认识你。', '他停住了。', '你走吧。', '他走了。');
    await flow.playAuto(d, 2);
    assert.equal(d.play.messages.length, 7);
    assert.ok(sent.at(-4).user.includes('刁难'), '玩家风格带进去');
    assert.ok(sent.at(-4).user.includes('他没回答。'), '带上前面的对话');
    // 重来
    replies.push('他回头了。');
    await flow.playRedo(d);
    assert.equal(d.play.messages.at(-1).text, '他回头了。');
    assert.equal(d.play.messages.length, 7);
    // 点评
    replies.push(JSON.stringify({ score: 6, good: ['说话克制'], issues: [{ where: '第 3 条', problem: '只会接话', part: 'persona', name: '迟春', fix: '给他一件自己想做的事' }, { problem: '开场白没留钩子', part: 'greet', fix: '停在要回应的瞬间' }, { problem: 'x', part: '乱写', fix: 'y' }] }));
    await flow.playReview(d);
    assert.equal(d.play.review.score, 6);
    assert.ok(sent.at(-1).user.includes('[第 3 条]'));
    assert.deepEqual(flow.reviewTarget(d, d.play.review.issues[0]), { page: 'persona', key: 'persona:迟春' });
    assert.deepEqual(flow.reviewTarget(d, d.play.review.issues[1]), { page: 'greet', key: `greet:${d.play.route}` });
    assert.equal(d.play.review.issues[2].part, 'persona', '不认识的部分算人设');
    // 试玩回复能扫八股，但不能清理
    const ps = flow.textSlots(d, { all: true }).filter((x) => x.page === 'play');
    assert.ok(ps.length && ps.every((x) => x.scanOnly));
});

await check('token：估算中文按字，酒馆分词器算完后用精确值', async () => {
    const { estimateTokens, makeTokenCounter, fmtTokens } = await import('../src/tokens.js');
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('春天结束'), 4);
    assert.equal(estimateTokens('abcdefgh'), 2);
    let updated = 0;
    const tc = makeTokenCounter(() => async (t) => t.length * 2, () => { updated++; });
    const a = tc.count('春天');
    assert.deepEqual(a, { n: 2, exact: false });
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(tc.count('春天'), { n: 4, exact: true });
    assert.ok(updated >= 1);
    assert.equal(fmtTokens(tc.sum(['春天', ''])), '4 token');
    assert.equal(fmtTokens({ n: 1234, exact: false }), '约 1,234 token');
    const none = makeTokenCounter(() => undefined, () => {});
    assert.equal(none.count('春天').exact, false, '没有分词器就一直估算');
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
    const routeOrders = Object.values(merged.entries).filter((x) => x.comment.startsWith('路线·')).map((x) => x.order || 0);
    assert.ok(by['路线·重逢'].order > (by['路线·孤儿时期'].order || 0) && new Set(routeOrders).size === routeOrders.length, '新路线的顺序号接在原来的路线后面，不重复');
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

await check('AU：开新草稿（原卡不动）→ 提取内核 → 映射表 → AU 人设带内核和映射 → 一致性检查 → 按结果修', async () => {
    const card = { avatar: '黎曙.png', data: { name: '黎曙', description: '他是扒手团的孤儿，只信自己，但对一起挨过饿的人放不下。', first_mes: '原开场', tags: ['BG', '1v1', '古言', '扒手/盗贼'] } };
    const a = flow.auStart(card, { entries: { 0: { uid: 0, comment: '扒手团', key: [], content: '领头叫老鬼', constant: true } } }, 'x');
    assert.equal(a.name, '黎曙（AU）');
    assert.equal(a.existing, undefined, 'AU 是新卡，不是改原卡');
    assert.deepEqual(a.personas.map((p) => [p.name, p.text]), [['黎曙', '']]);
    assert.deepEqual(a.tags.map((t) => t.name), ['BG', '1v1'], '题材、原型这些原作标签不带过来');
    await assert.rejects(() => flow.auMap(a), /AU 设定/);

    replies.push('<<<内核:黎曙>>>\n矛盾轴: 只信自己 ↔ 放不下一起挨过饿的人\n<<<外壳>>>\n- 扒手团\n- 古代');
    await flow.auCore(a);
    assert.ok(sent.at(-1).user.includes('只信自己') && sent.at(-1).user.includes('领头叫老鬼'), '原卡全文发给 AI');
    assert.ok(a.au.core[0].text.includes('放不下'));
    assert.ok(a.au.shell.includes('扒手团'));

    a.idea = '现代都市，他是外卖骑手';
    replies.push('原：扒手团 → AU：城中村的外卖站｜一起熬夜跑单的人就是一起挨过饿的人');
    await flow.auMap(a);
    const mu = sent.at(-1).user;
    assert.ok(mu.includes('外卖骑手') && mu.includes('放不下') && mu.includes('- 扒手团'));
    assert.ok(a.au.map.includes('外卖站'));

    replies.push('<<<概要>>>\n外卖骑手。\n<<<人设>>>\n<黎曙>\n只信自己。他会把人拉到身后宣示主权。扒手团的规矩他还记得。\n</黎曙>');
    await flow.persona(a, '黎曙');
    const pu = sent.at(-1).user;
    assert.ok(pu.includes('【角色内核】') && pu.includes('【映射表】') && pu.includes('原作的地名、组织、道具、事件不要出现'), 'AU 人设的提示词里有内核和映射表');
    assert.ok(!pu.includes('领头叫老鬼'), '生成 AU 人设时不给原卡全文');

    replies.push(JSON.stringify({ items: [{ core: '只信自己', verdict: '保留' }, { core: '放不下一起挨过饿的人', verdict: '丢了', where: '没写到', fix: '写他会替站里的新人兜底' }], leftovers: ['扒手团'] }));
    const c = await flow.auCheck(a, '黎曙');
    assert.equal(c.items.filter((x) => x.verdict !== '保留').length, 1);
    assert.deepEqual(c.leftovers, ['扒手团']);
    assert.ok(sent.at(-1).user.includes('放不下') && sent.at(-1).user.includes('宣示主权'));

    replies.push('<黎曙>\n只信自己，但会替站里的新人兜底。\n</黎曙>');
    await flow.auFix(a, '黎曙');
    const fu = sent.at(-1).user;
    assert.ok(fu.includes('写他会替站里的新人兜底') && fu.includes('原作世界的残留：扒手团'), '偏离和残留变成修改意见');
    assert.ok(a.personas[0].text.includes('兜底'));
    assert.equal(a.au.checks['黎曙'].fixed, true);

    // 世界观等后续步骤也拿到 AU 摘要
    replies.push('<世界观>\n城中村\n</世界观>');
    await flow.world(a);
    assert.ok(sent.at(-1).user.includes('外卖骑手') && sent.at(-1).user.includes('【角色内核】'));
    // 内核和映射表能换回上一版
    replies.push('原：扒手团 → AU：快递站');
    await flow.auMap(a);
    flow.restore(a, 'au:map');
    assert.ok(a.au.map.includes('外卖站'));
});

await check('展开经历：单独写经历，合并进人设的 life_story；经历太少会被质检标出来', async () => {
    const { lifeStoryStats, thinLifeStory, scanCard } = await import('../src/checks.js');
    const e = { ...emptyDraft(), personas: [{ name: '阿九', keys: [], overview: '', text: '<阿九>\n角色详情:\n  阿九:\n    identity: 扒手\n    life_story:\n      - 进了扒手团 → 只信自己\n    current_state:\n      - 在城里\n</阿九>' }] };
    assert.ok(thinLifeStory(e.personas[0].text));
    assert.ok(scanCard(e.personas[0].text, 'persona').some((i) => i.type === 'story'));
    replies.push('好的\nlife_story:\n  - 时期: 七八岁\n    发生了什么: 冬天被领头扔在桥下，是一起挨饿的小哥把半块饼塞给他，第二天小哥被打断了手。\n    留下了什么: 欠了的要还，也怕再欠谁\n    现在: 有人对他好，他先算自己欠了多少\n  - 时期: 十二岁\n    发生了什么: 他第一次偷到大户人家的东西，交给领头时被扣下一半，他没吭声，夜里把那一半又偷了回来。\n    留下了什么: 吃亏不当场说，但一定讨回来\n    现在: 被人占便宜时脸上不显，过几天才动手\n  - 时期: 十五岁\n    发生了什么: 他决定离开扒手团，走到城门口被〔user〕拽住了手，他骂了一路，最后还是带上了。\n    留下了什么: 走不掉，也不想真走掉\n    现在: 想走的时候会先回头看〔user〕在不在');
    const st = await flow.backstory(e, '阿九');
    const u = sent.at(-1).user;
    assert.ok(u.includes('为角色「阿九」写过去的经历') && u.includes('只信自己') && u.includes('4–7'));
    assert.equal(st.count, 3);
    const t = e.personas[0].text;
    assert.ok(t.includes('      - 时期: 七八岁') && t.includes('        发生了什么: 冬天'), '缩进对齐人设');
    assert.ok(!t.includes('进了扒手团 → 只信自己'), '原来那句被换掉');
    assert.ok(t.includes('    current_state:') && t.endsWith('</阿九>'));
    assert.ok(!thinLifeStory(t));
    flow.restore(e, 'persona:阿九');
    assert.ok(e.personas[0].text.includes('进了扒手团 → 只信自己'), '能换回上一版');
    replies.push('没按格式');
    await assert.rejects(() => flow.backstory(e, '阿九'), /没按格式/);
});

assert.equal(replies.length, 0);
console.log(`\n${passed} passed`);
