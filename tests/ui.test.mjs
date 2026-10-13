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
    extensionSettings: { baguCleaner: { userWords: '' }, connectionManager: { profiles: [] }, cardWorkshop: { minInterval: 0 } },
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
    async getCharacters() { ctx.characters = [{ avatar: '迟春.png', name: '迟春' }, { avatar: '黎曙.png', name: '黎曙' }]; },
    async selectCharacterById(i) { ctx.selected = i; },
    getPresetManager: () => null,
    stopGeneration() {},
    async generateRaw({ prompt }) { return respond(prompt); },
};
globalThis.SillyTavern = { getContext: () => ctx };
const cards = {
    '黎曙.png': { avatar: '黎曙.png', name: '黎曙', data: { name: '黎曙', description: '他是扒手团的孤儿。', personality: '', scenario: '', mes_example: '', first_mes: '原开场', alternate_greetings: ['原开场2'], tags: ['BG'], extensions: { world: '黎曙的书' } } },
};
worlds['黎曙的书'] = { entries: {
    0: { uid: 0, comment: '扒手团', key: ['扒手团'], content: '领头叫老鬼', constant: false, disable: false },
    1: { uid: 1, comment: '路线·孤儿时期', key: [], content: '<玩家信息>A</玩家信息>', constant: true, disable: false },
} };
globalThis.fetch = async (url, opts) => {
    requests.push({ url, body: JSON.parse(opts.body) });
    if (url === '/api/characters/get') {
        const c = cards[JSON.parse(opts.body).avatar_url];
        return c ? { ok: true, json: async () => structuredClone(c) } : { ok: false, status: 404 };
    }
    if (url === '/api/characters/merge-attributes') {
        const b = JSON.parse(opts.body);
        const c = cards[b.avatar];
        if (c) {
            for (const [k, v] of Object.entries(b.data)) {
                if (k === 'extensions') c.data.extensions = { ...c.data.extensions, ...v };
                else if (v === '__@@UNSET@@__') delete c.data[k];
                else c.data[k] = v;
            }
        }
        return { ok: true, text: async () => '' };
    }
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
    if (u.includes('这是一张已经写好的卡。给它想')) return JSON.stringify({ routes: [{ name: '重逢', user: '仇人', period: '十年后', why: '他欠你一条命' }] });
    if (u.includes('按作者的意见修改下面这段')) return '领头叫鬼姐，是个女人。';
    if (u.includes('针对这个脑洞问作者')) return JSON.stringify({ questions: [{ q: '那个拥抱为什么没完成？', options: ['你犹豫了', '他先走了', '春天提前结束'] }] });
    if (u.includes('开场白的梗，先不写正文')) return JSON.stringify({ hooks: ['庙门口他在等', '雨夜桥下', '春祭当天', '夏天他出现了', '他认出了你'] });
    if (u.includes('把下面每个梗扩写成')) return (u.slice(u.indexOf('【梗】'), u.indexOf('【路线】')).match(/^\d+\. /gm) || []).map((_, i) => `<<<开场白>>>\n扩写的开场白${i + 1}`).join('\n');
    if (u.includes('帮作者想清楚')) return JSON.stringify({ chars: [{ name: '迟春', questions: [{ q: '他为什么宁愿消失也要这个拥抱？', options: ['锚', '告别', '赌注'] }] }] });
    if (u.includes('为角色「迟春」写人设')) return '<<<概要>>>\n他是春天本身，〔user〕是唯一记得他的人。\n<<<人设>>>\n<迟春>\n角色详情:\n  迟春:\n    行为指导:\n      性格解释与行为表现:\n        - 吃醋时把人拉到身后宣示主权\n</迟春>';
    if (u.includes('只给你一个角色的类型标签')) return JSON.stringify({ scenes: [{ scene: '吃醋', behavior: '他会把人拉到身后宣示主权', line: '你是我的' }], traits: [] });
    if (u.includes('找出人设里本质上就是刻板写法的句子')) return JSON.stringify({ overlaps: [{ card: '吃醋时把人拉到身后宣示主权', stereotype: '他会把人拉到身后宣示主权', why: '一样' }] });
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

async function go(page) {
    const el = cw().find(`[data-act="go"][data-page="${page}"]`).get(0) ?? (page !== 'home' ? (await go('home'), cw().find(`[data-act="go"][data-page="${page}"]`).get(0)) : null);
    assert.ok(el, `找不到去 ${page} 的入口`);
    el.click();
    await tick();
}
const title = () => cw().find('.cw-ptitle').text();

await check('扩展加载：魔棒菜单和设置面板都有，提示词编辑不在设置面板里', () => {
    assert.ok($('#cw_menu_button').text().includes('写卡工坊'));
    assert.ok($('.cw-settings').text().includes('“设置”和“提示词”'));
    assert.equal($('.cw-settings .cw-step-ta').length, 0);
});

await check('打开是目录：每一步一个入口，提示“下一步”', async () => {
    $('#cw_menu_button').trigger('click');
    await until(() => cw().length);
    assert.equal(cw().find('.cw-tile').length, 13, '11 步 + 设置 + 提示词');
    assert.ok(cw().find('.cw-next').text().includes('一句话构想'));
    assert.equal(cw().find('textarea[data-bind="idea"]').length, 0, '目录页不堆内容');
});

await check('一句话构想页：生成构想，标签页里自动勾上（性向多选）', async () => {
    await go('idea');
    assert.ok(title().includes('一句话构想'));
    type('textarea[data-bind="idea"]', '“最后抱我一次吧，在春天结束之前。”……可春天已在你眼前离去了。');
    await click('[data-act="ideaQA"]');
    await click('.cw-opt[data-val="春天提前结束"]');
    assert.equal(draft().ideaQA[0].answer, '春天提前结束');
    await click('.cw-primary[data-act="idea"]');
    assert.ok(prompts.at(-1).includes('【作者补充】') && prompts.at(-1).includes('春天提前结束'), '有脑洞时也能问答，回答带进构想');
    assert.equal(draft().concepts.length, 1);
    assert.ok(cw().find('.cw-card').text().includes('他每年春天回来'));
    assert.ok(cw().find('.cw-foot').text().includes('下一步：标签'));
    await go('tags');
    const on = cw().find('.cw-chips').first().find('.cw-chip.tag.on').map((_, e) => e.textContent).get();
    for (const n of ['BG?', '1v1?', '酸涩', 'BE']) assert.ok(on.includes(n), `${n}：${on.join(' ')}`);
    assert.ok(cw().text().includes('新标签：季节限定'));
    await click('[data-act="tag"][data-dim="cp"][data-name="GB"]');
    assert.deepEqual(draft().tags.filter((t) => t.dim === 'cp').map((t) => t.name), ['BG', 'GB'], '性向可以同时选 BG 和 GB');
    await click('[data-act="tag"][data-dim="cp"][data-name="GB"]');
});

await check('收录新标签，回构想页选构想', async () => {
    await click('[data-act="adoptTag"]');
    assert.ok(ctx.extensionSettings.cardWorkshop.customTags.plot.includes('季节限定|季节限定'));
    assert.ok(draft().tags.some((t) => t.name === '季节限定'));
    await go('idea');
    await click('[data-act="pick"]');
    assert.equal(draft().name, '迟春');
    await go('home');
    assert.ok(cw().find('input[data-bind="name"]').val() === '迟春');
    assert.ok(cw().find('.cw-tile.done').text().includes('一句话构想'));
    assert.ok(cw().find('.cw-next').text().includes('主要人设'), '下一步提示指向人设');
});

await check('掷骰子：选了答案后有醒目的“用回答生成构想”', async () => {
    const d = draft();
    d.dice = { era: '古言' };
    d.inspire = [{ q: '谁欠了谁？', options: ['他欠她一条命', '两清了'], answer: '' }];
    await go('idea');
    await click('.cw-opt[data-val="两清了"]');
    assert.equal(draft().inspire[0].answer, '两清了');
    assert.equal(cw().find('input[data-bind="inspire.0.answer"]').val(), '', '点了选项，输入框不重复显示');
    assert.ok(cw().find('.cw-primary[data-act="ideaFromInspire"]').length);
    d.dice = {}; d.inspire = [];
});

await check('问答：点选项，答案写进草稿', async () => {
    await go('persona');
    await click('[data-act="qa"]');
    await click('.cw-opt[data-val="锚"]');
    assert.equal(draft().qa.chars[0].questions[0].answer, '锚');
});

await check('一键出卡（在目录）：跑完后跳到质检页', async () => {
    await go('home');
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
    assert.ok(title().includes('质检'));
    assert.ok(toasts.every((t) => t[0] !== 'err'), JSON.stringify(toasts));
});

await check('设置页：在插件里改 API 间隔和人设位置', async () => {
    await go('settings');
    assert.ok(title().includes('设置'));
    assert.ok(cw().find('[data-set="presetGreeting"]').length && cw().find('[data-set="apiProfile"]').length);
    const sel = cw().find('[data-set="personaPlace"]').get(0);
    assert.equal(sel.value, 'blue');
    sel.value = 'green'; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(ctx.extensionSettings.cardWorkshop.personaPlace, 'green');
    sel.value = 'blue'; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
});

await check('人设页：显示禁用词，计数显示调用次数', async () => {
    await go('persona');
    type('textarea[data-bind="personas.0.text"]', draft().personas[0].text + '\n    补充: 他的执念很深');
    await go('home'); await go('persona');
    assert.ok(cw().find('.cw-err').text().includes('执念'));
    assert.match(cw().find('.cw-meta').text(), /共 \d+ 次/);
    draft().personas[0].text = draft().personas[0].text.replace('\n    补充: 他的执念很深', '');
});

await check('修改意见 + 换回上一版（基调页）；开场白页能直接选预设', async () => {
    await go('tone');
    const before = draft().tone;
    type('input[data-bind="feedback.tone"]', '冲突再尖锐一点');
    assert.equal(draft().feedback.tone, '冲突再尖锐一点');
    await click('[data-act="tone"]');
    assert.ok(prompts.at(-1).includes('冲突再尖锐一点') && prompts.at(-1).includes('【上一版】'));
    assert.equal(cw().find('input[data-bind="feedback.tone"]').val(), '', '用完清空');
    await click('[data-act="restore"][data-key="tone"]');
    assert.equal(draft().tone, before);
    await go('greet');
    assert.ok(cw().find('[data-set="presetGreeting"]').length, '开场白页上就能选预设');
    assert.ok(cw().find('input[data-bind="feedback.greet:第一个春天"]').length);
});

await check('开场白：想梗 → 勾选/改字/自己写 → 扩写', async () => {
    await go('greet');
    const n0 = draft().greetings.length;
    await click('[data-act="hooks"][data-i="0"]');
    assert.equal(cw().find('.cw-hooktext[data-r="0"]').length, 5);
    const cb = cw().find('.cw-hookcheck[data-r="0"][data-h="1"]').get(0);
    cb.checked = true; cb.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    const t = cw().find('.cw-hooktext[data-r="0"][data-h="1"]').get(0);
    t.value = '雨夜桥下，他浑身湿透'; t.dispatchEvent(new window.Event('input', { bubbles: true }));
    const nh = cw().find('.cw-newhook[data-r="0"]').get(0);
    nh.value = '我写的：春祭上他认出了我';
    await click('[data-act="addHook"][data-i="0"]');
    assert.ok(cw().find('.cw-primary[data-act="expand"]').text().includes('扩写勾选的 2 个'));
    await click('[data-act="expand"][data-i="0"]');
    assert.ok(prompts.at(-1).includes('1. 雨夜桥下，他浑身湿透\n2. 我写的：春祭上他认出了我'));
    assert.equal(draft().greetings.length, n0 + 2);
    assert.equal(cw().find('.cw-hook.used').length, 2);
});

await check('手动编辑：改人设文本、加一个自由模块', async () => {
    await go('persona');
    type('textarea[data-bind="personas.0.overview"]', '他是春天本身。');
    assert.equal(draft().personas[0].overview, '他是春天本身。');
    await go('tone');
    await click('[data-act="add"][data-path="free"]');
    type('input[data-bind="free.0.name"]', '信物');
    type('textarea[data-bind="free.0.content"]', '<信物>旧怀表</信物>');
    assert.equal(draft().free[0].name, '信物');
});

await check('导入酒馆：世界书不重名、条目按桶型排、角色卡绑定世界书', async () => {
    worlds['迟春'] = { entries: {} };
    await go('import');
    await click('[data-act="import"]');
    const book = worlds['迟春 (2)'];
    assert.ok(book, `世界书：${Object.keys(worlds)}`);
    const es = Object.values(book.entries);
    const by = Object.fromEntries(es.map((e) => [e.comment, e]));
    assert.equal(by['基调与规则'].position, 0);
    assert.ok(!by['人设概要'], '默认人设蓝灯，不单独放概要');
    assert.equal(by['人设·迟春'].constant, true);
    assert.deepEqual(by['人设·迟春'].key, ['迟春']);
    assert.equal(by['路线·第一个春天'].disable, false);
    assert.equal(by['路线·失去之后'].disable, true);
    assert.ok(by['模块·信物']);
    const create = requests.find((r) => r.url === '/api/characters/create').body;
    assert.equal(create.ch_name, '迟春');
    assert.equal(create.world, '迟春 (2)');
    assert.equal(create.alternate_greetings.length, 3, '原来 2 个 + 扩写的 2 个，主开场白占 1 个');
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
    await go('intro');
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

await check('提示词页：改步骤提示词和规则库，生成时生效；恢复默认', async () => {
    const s = ctx.extensionSettings.cardWorkshop;
    await go('prompts');
    assert.ok(cw().find('.cw-step-ta').val().includes('【任务】为角色「{{name}}」写人设'), '默认显示人设步骤');
    const ta = cw().find('.cw-step-ta').get(0);
    ta.value = ta.value + '\n我自己加的一句Y';
    ta.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.ok(s.prompts.persona.includes('我自己加的一句Y'));
    await click('[data-act="ptab"][data-tab="rule"]');
    const rt = cw().find('.cw-rule-ta').get(0);
    rt.value = '只写特异点。自定义规则X';
    rt.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(s.rules['通用'], '只写特异点。自定义规则X');
    await go('persona');
    await click('[data-act="persona"]');
    assert.ok(prompts.at(-1).includes('自定义规则X') && prompts.at(-1).includes('我自己加的一句Y'), '人设步骤用了改过的提示词和规则');
    await go('prompts');
    await click('[data-act="ptab"][data-tab="rule"]');
    await click('[data-act="resetRule"]');
    assert.equal(s.rules['通用'], '');
    await click('[data-act="ptab"][data-tab="step"]');
    await click('[data-act="resetStep"]');
    assert.equal(s.prompts.persona, '');
});

await check('我的步骤：选放在哪一步后面，目录里出现单独一页，一键出卡也能跑', async () => {
    const s = ctx.extensionSettings.cardWorkshop;
    await go('prompts');
    await click('[data-act="ptab"][data-tab="mine"]');
    await click('[data-act="addStep"]');
    assert.equal(s.customSteps.length, 1);
    type('[data-step="0"][data-key="name"]', '预言');
    type('[data-step="0"][data-key="template"]', '为{{concept}}写一则预言。只写特异点。帮作者想清楚');
    const sel = cw().find('[data-step="0"][data-key="after"]').get(0);
    sel.value = 'world'; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(s.customSteps[0].after, 'world');
    await go('home');
    const tiles = cw().find('.cw-tile').map((_, e) => $(e).find('.cw-tn').text()).get();
    const iw = tiles.findIndex((t) => t.includes('世界观'));
    assert.ok(tiles[iw + 1].includes('预言'), `目录：${tiles.join(' / ')}`);
    await go(`step:${s.customSteps[0].id}`);
    assert.ok(title().includes('预言'));
    assert.ok(cw().find('.cw-foot').text().includes('下一步：NPC'));
    await click('[data-act="custom"]');
    const f = draft().free.find((x) => x.fromStep === s.customSteps[0].id);
    assert.equal(f.name, '预言');
    assert.ok(cw().find(`textarea[data-bind="free.${draft().free.indexOf(f)}.content"]`).length, '页面里能直接改产出');
    await go('tone');
    assert.ok(!cw().find('input[data-bind$=".name"]').get().some((e) => e.value === '预言'), '基调页的自由模块里不再重复显示');
    // 勾上“一键出卡时也跑”，清空产出，一键出卡会把它补上
    s.customSteps[0].auto = true;
    f.content = '';
    const n0 = prompts.length;
    await go('home');
    await click('[data-act="auto"]');
    assert.ok(f.content, '一键出卡跑了我的步骤');
    assert.ok(prompts.slice(n0).some((p) => p.includes('写一则预言')));
});

await check('简介风格：存一个自己的，切换时只重排不调 API；分段修改后重新排版', async () => {
    const s = ctx.extensionSettings.cardWorkshop;
    await go('prompts');
    await click('[data-act="ptab"][data-tab="intro"]');
    await click('[data-act="addIntroStyle"]');
    const tpl = cw().find('.cw-istpl[data-i="0"]').get(0);
    tpl.value = '{{标题}}\n{{简介}}'; tpl.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(s.introStyles[0].tpl, '{{标题}}\n{{简介}}');
    await go('intro');
    const n0 = prompts.length;
    const sel = cw().find('.cw-introstyle').get(0);
    sel.value = '1'; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    assert.equal(prompts.length, n0, '换风格不调 API');
    assert.ok(!draft().intro.text.includes('## 关于TA'));
    const part = cw().find('textarea[data-bind="intro.parts.简介"]').get(0);
    part.value = '改过的简介'; part.dispatchEvent(new window.Event('input', { bubbles: true }));
    await click('[data-act="recompose"]');
    assert.ok(draft().intro.text.endsWith('改过的简介'));
    sel.value = '0';
    const sel2 = cw().find('.cw-introstyle').get(0); sel2.value = '0'; sel2.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    assert.ok(draft().intro.text.includes('## 关于TA'));
});

await check('八股清理不碰基调与规则', async () => {
    await go('check');
    draft().tone = '<创作文体>\n调性: 嘴角勾起一抹若有若无的弧度也不行\n</创作文体>';
    const before = draft().tone;
    await click('[data-act="baguFix"]');
    assert.equal(draft().tone, before);
});

await check('改已有的卡：选卡读进来，原卡内容页能改、按意见改', async () => {
    await ctx.getCharacters();
    await go('home');
    await click('[data-act="go"][data-page="load"]');
    assert.ok(title().includes('改已有的卡'));
    cw().find('.cw-cardsel').val('黎曙.png');
    await click('[data-act="loadCard"]');
    assert.ok(title().includes('原卡内容'));
    const d = draft();
    assert.equal(d.existing.avatar, '黎曙.png');
    assert.equal(d.personas[0].fromDescription, true);
    assert.equal(d.existing.entries[0].comment, '扒手团');
    assert.equal(ctx.extensionSettings.cardWorkshop.drafts[0].name, '迟春', '原来的草稿进了历史');
    type('input[data-bind="feedback.exist:entry:0"]', '领头改成女的');
    await click('[data-act="revise"][data-key="exist:entry:0"]');
    assert.equal(draft().existing.entries[0].content, '领头叫鬼姐，是个女人。');
    assert.ok(cw().find('[data-act="restore"][data-key="exist:entry:0"]').length);
});

await check('改已有的卡：想新路线 → 加上 → 一键补全只写新路线和它的开场白', async () => {
    await go('routes');
    await click('[data-act="suggestRoutes"]');
    assert.ok(cw().text().includes('他欠你一条命'));
    await click('[data-act="addRouteIdea"]');
    assert.deepEqual(draft().routes.map((r) => r.name), ['孤儿时期', '重逢']);
    const n0 = prompts.length;
    await go('home');
    assert.ok(cw().find('[data-act="auto"]').text().includes('一键补全'));
    await click('[data-act="auto"]');
    const ps = prompts.slice(n0);
    assert.equal(draft().routes[0].info, '<玩家信息>A</玩家信息>', '原路线没动');
    assert.ok(draft().routes[1].info, '新路线写好了');
    assert.equal(ps.filter((p) => p.includes('的开场白，共')).length, 1, '只给新路线写开场白');
    assert.ok(ps.find((p) => p.includes('的开场白，共')).includes('路线「重逢」'));
    assert.ok(!ps.some((p) => p.includes('方向不同的角色卡构想') || p.includes('为这张卡写世界观')), '不重新出构想、不重写世界观');
});

await check('改已有的卡：写回原卡（条目合并、新开场白加在后面、内嵌世界书同步），再撤销', async () => {
    draft().personas[0].text = '他是扒手团的孤儿，十年后成了城主。';
    await go('import');
    assert.ok(cw().text().includes('写回原卡：黎曙'));
    await click('[data-act="writeBack"]');
    const c = cards['黎曙.png'].data;
    assert.equal(c.description, '他是扒手团的孤儿，十年后成了城主。');
    assert.equal(c.first_mes, '原开场');
    assert.equal(c.alternate_greetings[0], '原开场2');
    assert.ok(c.alternate_greetings.length >= 2, '新开场白加在后面');
    const book = worlds['黎曙的书'];
    const by = Object.fromEntries(Object.values(book.entries).map((e) => [e.comment, e]));
    assert.equal(by['扒手团'].content, '领头叫鬼姐，是个女人。');
    assert.ok(by['路线·重逢'] && by['路线·重逢'].disable === true, '新路线默认不启用');
    assert.equal(by['路线·孤儿时期'].disable, false);
    assert.equal(c.character_book.entries.length, Object.keys(book.entries).length, '卡里嵌的世界书同步了');
    assert.equal(draft().greetings.length, 0, '新开场白并进了原卡开场白');
    // 撤销
    await click('[data-act="undoWriteBack"]');
    assert.equal(cards['黎曙.png'].data.description, '他是扒手团的孤儿。');
    assert.deepEqual(cards['黎曙.png'].data.alternate_greetings, ['原开场2']);
    assert.equal(worlds['黎曙的书'].entries[0].content, '领头叫老鬼');
    assert.ok(!cards['黎曙.png'].data.character_book, '原来没有内嵌世界书，撤销后也没有');
});

await check('新建草稿：旧的进历史，能读回来', async () => {
    await go('home');
    await click('[data-act="newDraft"]');
    assert.equal(draft().idea, '');
    const s = ctx.extensionSettings.cardWorkshop;
    assert.equal(s.drafts[0].name, '黎曙');
    assert.equal(s.drafts[1].name, '迟春');
    const sel = cw().find('.cw-hist').get(0);
    sel.value = '1';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    assert.equal(draft().name, '迟春');
    assert.deepEqual(s.drafts.map((x) => x.name), ['黎曙'], '读回来的草稿离开历史；新建的空草稿不进历史');
});

fs.rmSync(tp, { recursive: true, force: true });
console.log(`\n${passed} passed${withBagu ? '（含八股清理联动）' : '（没找到八股清理，跳过联动）'}`);
process.exit(0);
