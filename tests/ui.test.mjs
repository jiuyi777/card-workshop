// node tests/ui.test.mjs [八股清理目录]
// 在 jsdom 里模拟酒馆：加载真正的 index.js，点按钮跑完一张卡，检查导入时发给酒馆的请求。
// 会把写卡工坊和八股清理复制到临时的 third-party 目录，测试两个扩展之间的联动。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import jqueryFactory from 'jquery';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const baguDir = path.resolve(process.argv[2] ?? path.join(root, '../jiuyi777/bagu-cleaner'));
const tp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-third-party-'));
fs.cpSync(root, path.join(tp, 'card-workshop'), { recursive: true, filter: (s) => !s.includes('node_modules') && !s.includes(`${path.sep}.git`) });
const withBagu = fs.existsSync(path.join(baguDir, 'engine.js'));
if (withBagu) fs.cpSync(baguDir, path.join(tp, 'bagu-cleaner'), { recursive: true, filter: (s) => !s.includes(`${path.sep}.git`) });

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

// ───── 模拟酒馆页面 ─────
const dom = new JSDOM('<!doctype html><body><div id="extensions_settings2"></div><div id="extensionsMenu"></div></body>', { url: 'http://localhost/' });
const { window } = dom;
const $ = jqueryFactory(window);
Object.assign(globalThis, { window, document: window.document, $, jQuery: $, HTMLElement: window.HTMLElement, Blob: window.Blob });
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });
const toasts = [];
globalThis.toastr = { success: (m) => toasts.push(['ok', m]), error: (m) => toasts.push(['err', m]), info: (m) => toasts.push(['info', m]), warning: (m) => toasts.push(['warn', m]) };

const POPUP_TYPE = { TEXT: 1, CONFIRM: 2 };
const worlds = { 已有的书: { entries: {} } };
const requests = [];
const prompts = [];
const ctx = {
    extensionSettings: { baguCleaner: { userWords: '' }, connectionManager: { profiles: [] } },
    saveSettingsDebounced() {},
    POPUP_TYPE,
    async callGenericPopup(content, type) {
        if (type === POPUP_TYPE.TEXT) { document.body.appendChild(content); return new Promise(() => {}); }
        return true;
    },
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    getWorldInfoNames: () => Object.keys(worlds),
    async saveWorldInfo(n, data) { worlds[n] = structuredClone(data); },
    async loadWorldInfo(n) { return structuredClone(worlds[n]); },
    async updateWorldInfoList() {},
    characters: [],
    async getCharacters() { ctx.characters = [{ avatar: '迟春.png', name: '迟春' }]; },
    async selectCharacterById(i) { ctx.selected = i; },
    getPresetManager: () => null,
    stopGeneration() {},
    async generateRaw({ prompt }) { return respond(prompt); },
};
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.fetch = async (url, opts) => {
    requests.push({ url, body: JSON.parse(opts.body) });
    if (url === '/api/characters/create') return { ok: true, text: async () => '迟春.png' };
    return { ok: true, text: async () => '' };
};

// ───── 假 API：按提示词里的任务认步骤 ─────
const GREETING = '桥下的雪化了一半。{{char}}嘴角勾起一抹若有若无的弧度。〔user〕停在三步外。';
function respond(messages) {
    const all = messages.map((m) => m.content).join('\n');
    prompts.push(all);
    assert.ok(!all.includes('<user>'), '发出去的提示词里不能有 <user>（会被酒馆换成名字）');
    const u = messages.at(-1).content;
    if (u.includes('方向不同的角色卡构想')) {
        return JSON.stringify({
            tags: { picked: ['酸涩'], guessed: { 性向: 'BG', 人数: '1v1', 卡类型: '单人卡' }, novel: [{ dim: '情节梗', name: '季节限定' }], surprise: { dim: '时代与题材', name: '规则怪谈', why: '循环' } },
            concepts: [{ title: '他每年春天回来，每年都不认识我', lineup: [{ name: '迟春', identity: '只在春天存在的人', archetype: ['神明'] }], user: ['记得一切的人'], relation: '去年春末他提出请求，你犹豫了。', tension: { core: '只有你记得', expect: ['他在夏天出现'] }, complexity: '中等', routes: [{ name: '第一个春天', user: '初见者', period: '去年' }, { name: '失去之后', user: '等待者', period: '今年' }], npcs: 1, tags: ['仙侠'] }],
        });
    }
    if (u.includes('帮作者想清楚')) return JSON.stringify({ chars: [{ name: '迟春', questions: [{ q: '他为什么宁愿消失也要这个拥抱？', options: ['锚', '告别', '赌注'] }] }] });
    if (u.includes('为角色「迟春」写人设')) return '<<<概要>>>\n他是春天本身，〔user〕是唯一记得他的人。\n<<<人设>>>\n<迟春>\n角色详情:\n  迟春:\n    行为指导:\n      性格解释与行为表现:\n        - 吃醋时把人拉到身后宣示主权\n</迟春>';
    if (u.includes('只给你一个角色的类型标签')) return JSON.stringify({ scenes: [{ scene: '吃醋', behavior: '他会把人拉到身后宣示主权', line: '你是我的' }], traits: [] });
    if (u.includes('和“这类角色的刻板写法”撞了')) return '<迟春>\n角色详情:\n  迟春:\n    行为指导:\n      性格解释与行为表现:\n        - 吃醋时把对方送他的东西还回去\n</迟春>';
    if (u.includes('为这张卡写世界观')) return '<世界观>\n规则: 春天结束，迟春散去\n</世界观>';
    if (u.includes('为这张卡写 NPC')) return '<<<NPC:守庙人|庙祝>>>\n<守庙人>\n功能: 提供信息\n</守庙人>';
    if (u.includes('为每条路线写玩家信息')) return '<<<路线:第一个春天>>>\n<玩家信息>〔user〕身份：初见者</玩家信息>\n<<<路线:失去之后>>>\n<玩家信息>〔user〕身份：等待者</玩家信息>';
    if (u.includes('写这张卡的基调与规则')) return '<创作文体>\n基石: 奇幻\n</创作文体>';
    if (u.includes('的开场白，共')) return `<<<开场白>>>\n${GREETING}`;
    if (u.includes('含八股的句子，逐句修改')) {
        const list = JSON.parse(u.slice(u.indexOf('【句子】') + 4));
        return JSON.stringify({ edits: list.map((t) => ({ id: t.id, text: t.句子.replace(/嘴角勾起一抹若有若无的弧度/, '笑了一下') })) });
    }
    if (u.includes('发到 Discord 的简介')) return '<<<标题>>>\n他每年春天回来，每年都不认识我\n春天结束之前\n最后抱我一次\n<<<题句>>>\n最后抱我一次吧，在春天结束之前。\n<<<简介>>>\n桥下站着一个人。\n<<<关于TA>>>\n**迟春**｜春天\n<<<路线>>>\n**第一个春天**｜初见 · 试探\n<<<内心想法>>>\n这次别犹豫了。';
    throw new Error(`没认出来的请求：${u.slice(0, 60)}`);
}

// ───── 工具 ─────
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(fn, ms = 5000) {
    const t0 = Date.now();
    while (!fn()) { if (Date.now() - t0 > ms) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 5)); }
}
const cw = () => $('.cw');
const idle = () => cw().length && cw().find('.cw-stop').css('display') === 'none';
async function click(sel, i = 0) {
    const el = cw().find(sel).get(i);
    assert.ok(el, `找不到 ${sel}`);
    el.click();
    await tick();
    await until(idle);
}
function type(sel, value) {
    const el = cw().find(sel).get(0);
    assert.ok(el, `找不到 ${sel}`);
    el.value = value;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
}
const draft = () => ctx.extensionSettings.cardWorkshop.draft;

// ───── 加载扩展 ─────
await import(pathToFileURL(path.join(tp, 'card-workshop', 'index.js')).href);
await until(() => $('#cw_menu_button').length && $('.cw-settings').length);

await check('扩展加载：魔棒菜单和设置面板都有', () => {
    assert.ok($('#cw_menu_button').text().includes('写卡工坊'));
    assert.ok($('.cw-settings').text().includes('步骤提示词'));
    assert.ok($('.cw-settings .cw-step-ta').val().includes('【任务】为角色「{{name}}」写人设'), '默认显示人设步骤的提示词');
});

await check('打开写卡工坊，一句话生成构想，标签自动勾上', async () => {
    $('#cw_menu_button').trigger('click');
    await until(() => cw().length);
    type('textarea[data-bind="idea"]', '“最后抱我一次吧，在春天结束之前。”……可春天已在你眼前离去了。');
    await click('[data-act="idea"]');
    assert.equal(draft().concepts.length, 1);
    assert.ok(cw().find('.cw-card').text().includes('他每年春天回来'));
    const on = cw().find('.cw-chip.tag.on').map((_, e) => e.textContent).get();
    for (const n of ['BG?', '1v1?', '酸涩', 'BE']) assert.ok(on.includes(n), `${n}：${on.join(' ')}`);
    assert.ok(cw().text().includes('新标签：季节限定'));
});

await check('收录新标签，选构想', async () => {
    await click('[data-act="adoptTag"]');
    assert.ok(ctx.extensionSettings.cardWorkshop.customTags.plot.includes('季节限定|季节限定'));
    assert.ok(draft().tags.some((t) => t.name === '季节限定'));
    await click('[data-act="pick"]');
    assert.equal(draft().name, '迟春');
    assert.ok(cw().find('input[data-bind="name"]').val() === '迟春');
});

await check('问答：点选项，答案写进草稿', async () => {
    await click('[data-act="qa"]');
    await click('.cw-opt[data-val="锚"]');
    assert.equal(draft().qa.chars[0].questions[0].answer, '锚');
});

await check('一键出卡：人设 → 世界观 → NPC → 路线 → 基调 → 开场白 → 可预测性重写 → 八股清理 → 质检', async () => {
    await click('[data-act="auto"]');
    const d = draft();
    assert.ok(d.personas[0].text.includes('还回去'), '撞车的那句被重写');
    assert.equal(d.predict['迟春'].overlaps.length, 0);
    assert.ok(d.world.main && d.npcs.length === 1 && d.tone);
    assert.equal(d.routes.filter((r) => r.info).length, 2);
    assert.equal(d.greetings.length, 2);
    assert.ok(d.routes[0].info.includes('<user>身份'), '收到后 〔user〕 换回 <user>');
    if (withBagu) {
        assert.ok(!d.greetings[0].text.includes('的弧度'), '开场白里的八股被八股清理改掉');
        assert.ok(d.greetings[0].text.includes('{{char}}笑了一下'));
        assert.ok(prompts.some((p) => p.includes('整句修改约束')), '用了八股清理的提示词');
    }
    assert.ok(prompts.find((p) => p.includes('为角色「迟春」写人设')).includes('锚'), '问答答案进了人设提示词');
    assert.ok(cw().find('[data-sec="check"]').prop('open'));
    assert.ok(toasts.every((t) => t[0] !== 'err'), JSON.stringify(toasts));
});

await check('手动编辑：改人设文本、加一个自由模块', async () => {
    type('textarea[data-bind="personas.0.overview"]', '他是春天本身。');
    assert.equal(draft().personas[0].overview, '他是春天本身。');
    await click('[data-act="add"][data-path="free"]');
    type('input[data-bind="free.0.name"]', '信物');
    type('textarea[data-bind="free.0.content"]', '<信物>旧怀表</信物>');
    assert.equal(draft().free[0].name, '信物');
});

await check('导入酒馆：世界书不重名、条目按桶型排、角色卡绑定世界书', async () => {
    worlds['迟春'] = { entries: {} };
    await click('[data-act="import"]');
    const book = worlds['迟春 (2)'];
    assert.ok(book, `世界书：${Object.keys(worlds)}`);
    const es = Object.values(book.entries);
    const by = Object.fromEntries(es.map((e) => [e.comment, e]));
    assert.equal(by['基调与规则'].position, 0);
    assert.equal(by['人设概要'].constant, true);
    assert.equal(by['人设·迟春'].constant, false);
    assert.deepEqual(by['人设·迟春'].key, ['迟春']);
    assert.equal(by['路线·第一个春天'].disable, false);
    assert.equal(by['路线·失去之后'].disable, true);
    assert.ok(by['模块·信物']);
    const create = requests.find((r) => r.url === '/api/characters/create').body;
    assert.equal(create.ch_name, '迟春');
    assert.equal(create.world, '迟春 (2)');
    assert.equal(create.alternate_greetings.length, 1);
    assert.ok(create.first_mes.includes('<user>停在三步外'), '开场白里的玩家写成 <user>');
    assert.ok(create.tags.includes('BG'));
    assert.equal(ctx.selected, 0);
    assert.equal(draft().imported.world, '迟春 (2)');
});

await check('切换路线：只开选中的那条', async () => {
    cw().find('.cw-route').val('1');
    await click('[data-act="switchRoute"]');
    const es = Object.values(worlds['迟春 (2)'].entries);
    assert.equal(es.find((e) => e.comment === '路线·失去之后').disable, false);
    assert.equal(es.find((e) => e.comment === '路线·第一个春天').disable, true);
});

await check('简介：生成、换标题、写进角色卡', async () => {
    ctx.extensionSettings.cardWorkshop.author = 'if love';
    await click('[data-act="intro"]');
    let text = draft().intro.text;
    assert.ok(text.startsWith('【BG|1v1|'));
    assert.ok(text.includes('-# 作者：**if love**'));
    assert.ok(!/^\s*\|.*\|\s*$/m.test(text), '没有表格');
    await click('[data-act="pickTitle"]', 1);
    text = draft().intro.text;
    assert.ok(text.split('\n')[0].endsWith('】春天结束之前'));
    await click('[data-act="saveIntro"]');
    const merge = requests.find((r) => r.url === '/api/characters/merge-attributes').body;
    assert.equal(merge.avatar, '迟春.png');
    assert.equal(merge.data.creator_notes, text);
});

await check('设置：改步骤提示词和规则库，生成时生效；恢复默认', async () => {
    const s = ctx.extensionSettings.cardWorkshop;
    $('.cw-settings .cw-rule-ta').val('只写特异点。自定义规则X').trigger('input');
    assert.equal(s.rules['通用'], '只写特异点。自定义规则X');
    await click('[data-act="persona"]');
    assert.ok(prompts.at(-1).includes('自定义规则X'), '人设步骤用了改过的规则');
    $('.cw-settings .cw-rule-reset').trigger('click');
    assert.equal(s.rules['通用'], '');
});

await check('我的步骤：设置里加一个，写卡里出现按钮，产出成为自由模块', async () => {
    const s = ctx.extensionSettings.cardWorkshop;
    $('.cw-settings .cw-step-add').trigger('click');
    assert.equal(s.customSteps.length, 1);
    $('.cw-settings [data-step="0"][data-key="name"]').val('预言').trigger('input');
    $('.cw-settings [data-step="0"][data-key="template"]').val('为{{concept}}写一则预言。只写特异点。帮作者想清楚').trigger('input');
    // 重新打开写卡工坊的视图
    cw().parent().remove();
    $('#cw_menu_button').trigger('click');
    await until(() => cw().find('[data-act="custom"]').length);
    const before = draft().free.length;
    await click('[data-act="custom"]');
    assert.equal(draft().free.length, before + 1);
    assert.equal(draft().free.at(-1).name, '预言');
});

await check('新建草稿：旧的进历史，能读回来', async () => {
    await click('[data-act="newDraft"]');
    assert.equal(draft().idea, '');
    const s = ctx.extensionSettings.cardWorkshop;
    assert.equal(s.drafts[0].name, '迟春');
    const sel = cw().find('.cw-hist').get(0);
    sel.value = '0';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    assert.equal(draft().name, '迟春');
    assert.equal(s.drafts.length, 0, '读回来的草稿离开历史；新建的空草稿不进历史');
});

fs.rmSync(tp, { recursive: true, force: true });
console.log(`\n${passed} passed${withBagu ? '（含八股清理联动）' : '（没找到八股清理，跳过联动）'}`);
process.exit(0);
