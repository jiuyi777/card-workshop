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
    if (url === '/api/characters/create') {
        const b = JSON.parse(opts.body);
        cards['迟春.png'] = { avatar: '迟春.png', name: b.ch_name, data: { name: b.ch_name, description: b.description, personality: b.personality, scenario: b.scenario, mes_example: b.mes_example, first_mes: b.first_mes, alternate_greetings: b.alternate_greetings, extensions: { world: b.world } } };
        return { ok: true, text: async () => '迟春.png' };
    }
    return { ok: true, text: async () => '' };
};

// ───── 假 API：按提示词里的任务认步骤 ─────
const GREETING = '桥下的雪化了一半。{{char}}嘴角勾起一抹若有若无的弧度。〔user〕停在三步外。';
function respond(messages) {
    const all = messages.map((m) => m.content).join('\n');
    prompts.push(all);
    assert.ok(!all.includes('<user>'), '发出去的提示词里不能有 <user>（会被酒馆换成名字）');
    const u = messages.at(-1).content;
    if (String(messages[0]?.content).includes('你来扮演卡里的角色')) return `迟春看着〔user〕，没说话。（第 ${messages.length} 条）`;
    if (u.includes('为角色「〔新角色〕」写人设')) return '<<<名字>>>\n守春人\n<<<概要>>>\n〔新角色〕守着春神庙。\n<<<人设>>>\n<〔新角色〕>\n身份: 守庙人\n</〔新角色〕>';
    if (u.includes('写他们之间的关系网和多人演绎规则')) return '<角色关系>\n关系:\n  迟春 与 守春人: 旧账\n</角色关系>';
    if (u.includes('为这张卡写一个 NPC。')) return '<<<NPC:秦太医|太医>>>\n<秦太医>\n功能: 提供信息\n</秦太医>';
    if (u.includes('只改下面原文里用【【 】】括起来的那一段')) return '他嘴硬，什么都不认。';
    if (u.includes('扮演玩家〔user〕，给角色回一条消息')) return '（后退一步）你是谁？';
    if (u.includes('角色卡的试玩记录')) return JSON.stringify({ score: 6, good: ['克制'], issues: [{ where: '第 3 条', problem: '只会接话', part: 'persona', name: '迟春', fix: '给他一件自己想做的事' }] });
    if (u.includes('方向不同的角色卡构想')) {
        return JSON.stringify({
            tags: { picked: ['酸涩'], guessed: { 性向: 'BG', 人数: '1v1', 卡类型: '单人卡' }, novel: [{ dim: '情节梗', name: '季节限定' }], surprise: { dim: '时代与题材', name: '规则怪谈', why: '循环' } },
            concepts: [{ title: '他每年春天回来，每年都不认识我', lineup: [{ name: '迟春', identity: '只在春天存在的人', archetype: ['神明'] }], user: ['记得一切的人'], relation: '去年春末他提出请求，你犹豫了。', tension: { core: '只有你记得', expect: ['他在夏天出现'] }, complexity: '中等', routes: [{ name: '第一个春天', user: '初见者', period: '去年' }, { name: '失去之后', user: '等待者', period: '今年' }], npcs: 1, tags: ['仙侠'] }],
        });
    }
    if (u.includes('为角色「黎曙」写人设')) return '<<<概要>>>\n外卖骑手。\n<<<人设>>>\n<黎曙>\n只信自己。\n</黎曙>';
    if (u.includes('写过去的经历')) return 'life_story:\n  - 时期: 小时候\n    发生了什么: 有个人在冬天把半块饼塞给他，第二天那个人被打断了手，他一直记着这件事。\n    留下了什么: 欠了的要还\n    现在: 有人对他好时先算欠了多少\n  - 时期: 少年\n    发生了什么: 他第一次自己选择留下，代价是错过了唯一一次离开的机会，后来再也没走成。\n    留下了什么: 走不掉\n    现在: 想走时会回头\n  - 时期: 去年\n    发生了什么: 春天快结束的时候〔user〕说想抱他一次，他犹豫了，春天就结束了，他什么也没来得及做。\n    留下了什么: 怕再犹豫\n    现在: 看到〔user〕就往前走一步';
    if (u.includes('先把每个主要角色拆成两层')) return '<<<内核:黎曙>>>\n矛盾轴: 只信自己 ↔ 放不下一起挨过饿的人\n<<<外壳>>>\n- 扒手团';
    if (u.includes('把原作的外壳一项项换成 AU')) return '原：扒手团 → AU：城中村外卖站｜一起熬夜跑单的人就是一起挨过饿的人';
    if (u.includes('检查 AU 版人设有没有保住原作角色的内核')) return JSON.stringify({ items: [{ core: '只信自己', verdict: '保留' }, { core: '放不下一起挨过饿的人', verdict: '丢了', where: '没写到', fix: '写他替新人兜底' }], leftovers: [] });
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
const { lifeStoryStats } = await import(pathToFileURL(path.join(root, 'src/checks.js')).href);
const lifeStoryCount = (t) => lifeStoryStats(t).count;

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
    assert.equal(cw().find('.cw-tile').length, 15, '12 步 + 设置 + 关于 + 提示词');
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
    assert.ok(prompts.some((p) => p.includes('为角色「迟春」写过去的经历')), '人设里经历太少，一键出卡自动展开了经历');
    assert.ok(prompts.find((p) => p.includes('和“这类角色的刻板写法”撞了')).includes('发生了什么'), '展开的经历带进了后面的步骤（重写撞车时原样保留）');
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

await check('导入后再改：只写回勾选的部分，酒馆里改过的开场白不会被改回去', async () => {
    const d = draft();
    assert.ok(d.existing?.fromImport, '导入后算“已导入的卡”');
    assert.ok(!cw().find('.cw-tile[data-page="existing"]').length);
    const card = cards['迟春.png'].data;
    // 在酒馆里改了主开场白
    card.first_mes = '酒馆里改的主开场白';
    // 在写卡工坊改了世界观和第二个开场白
    d.world.main = '<世界观>\n改过的世界观\n</世界观>';
    const second = d.greetings.find((g) => g.slot === 1);
    if (second) second.text = '写卡工坊改的第二个开场白';
    await go('import');
    assert.ok(cw().text().includes('更新已导入的卡'));
    await click('[data-act="planWriteBack"]');
    assert.ok(!cw().find('.cw-planchk[data-id="g:0"]').prop('checked'), '酒馆里改的默认不勾');
    assert.ok(cw().find('.cw-planchk[data-id="e:c:世界观"]').prop('checked'));
    await click('[data-act="applyWriteBack"]');
    assert.equal(cards['迟春.png'].data.first_mes, '酒馆里改的主开场白');
    if (second) assert.equal(cards['迟春.png'].data.alternate_greetings[0], '写卡工坊改的第二个开场白');
    const book = worlds[cards['迟春.png'].data.extensions.world];
    assert.ok(Object.values(book.entries).find((e) => e.comment === '世界观').content.includes('改过的世界观'));
    assert.equal(d.greetings.find((g) => g.slot === 0).text, '酒馆里改的主开场白', '酒馆的版本同步回写卡工坊');
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
    const merge = requests.findLast((r) => r.url === '/api/characters/merge-attributes').body;
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
    assert.ok(draft().intro.text.includes('改过的简介'));
    assert.ok(draft().intro.text.trimEnd().endsWith('-# 感谢酒疫老师的写卡工坊'), '自己的风格没放致谢，写卡工坊那条也补在最后');
    sel.value = '0';
    const sel2 = cw().find('.cw-introstyle').get(0); sel2.value = '0'; sel2.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    assert.ok(draft().intro.text.includes('## 关于TA'));
    assert.ok(draft().intro.text.includes('## 致谢') && draft().intro.text.includes('感谢酒疫老师的写卡工坊') && draft().intro.text.includes('感谢灰鸠老师的人设模板'), '默认风格有致谢');
    // 改了人设模板，灰鸠老师那条自动去掉
    s.rules['人设模板'] = '我的模板:\n  {{name}}: x';
    await click('[data-act="recompose"]');
    assert.ok(!draft().intro.text.includes('灰鸠') && draft().intro.text.includes('感谢酒疫老师的写卡工坊'));
    s.rules['人设模板'] = '';
    await go('home');
    assert.ok(cw().find('.cw-credits').text().includes('本写卡工坊默认提示词来自灰鸠老师，请关注灰鸠老师喵'));
    assert.equal(cw().find('.cw-credits a, .cw-credits [data-act]').length, 0, '目录里的小字不能点');
    await click('.cw-tile[data-page="about"]');
    assert.ok(cw().find('a[href*="discord.com"]').length, '关于页有链接');
    assert.ok(title().includes('关于'));
    const about = cw().text();
    for (const w of ['酒疫', '灰鸠', '使用授权', '插件会动哪些东西', '八股清理']) assert.ok(about.includes(w), w);
    await go('home');
});

await check('开场白一写完就改掉必改词；八股检查显示文中真正的词', async () => {
    const S = ctx.extensionSettings.cardWorkshop;
    if (withBagu) {
        S.greetMustClean = false;
        await go('greet');
        await click('[data-act="greet"]');
        const route = draft().routes[0].name;
        assert.ok(draft().greetings.filter((g) => g.route === route).some((g) => g.text.includes('的弧度')), '关掉时不改');
        const bar = cw().find('.cw-bagubar').text();
        assert.ok(bar.includes('嘴角勾起一抹若有若无的弧度') || bar.includes('的弧度'), bar);
        assert.ok(!bar.includes('(?:'), '不显示规则写法');
        S.greetMustClean = true;
        const n = prompts.length;
        await click('[data-act="greet"]');
        assert.ok(!draft().greetings.filter((g) => g.route === route).some((g) => g.text.includes('的弧度')), '写完立刻改掉');
        assert.ok(cw().find('.cw-status').text().includes('顺手改掉了'));
        assert.equal(prompts.length - n, 2, '写开场白 1 次 + 改必改词 1 次');
    }
});

await check('局部重写：选中一段 → 框下出现按钮 → 只改这段，上面显示改了什么；文风可以新建、选上', async () => {
    await go('prompts');
    await click('[data-act="ptab"][data-tab="style"]');
    await click('[data-act="addStyle"]');
    type('.cw-sttext', '短句，少形容词');
    assert.equal(ctx.extensionSettings.cardWorkshop.styles[0].text, '短句，少形容词');
    await go('persona');
    const sel = cw().find('.cw-stylesel');
    sel.val('1').trigger('change');
    await tick();
    assert.equal(draft().style, 1);
    const p = draft().personas[0];
    p.text = '<迟春>\n性格:\n  - 他很温柔\n  - 每年春天去旧桥\n</迟春>';
    await go('persona');
    const ta = cw().find('textarea[data-bind="personas.0.text"]').get(0);
    const a = ta.value.indexOf('他很温柔');
    ta.setSelectionRange(a, a + 4);
    ta.dispatchEvent(new window.Event('select', { bubbles: true }));
    await tick(); await tick();
    assert.equal(cw().find('.cw-selbar').length, 1, '选中后出现局部重写');
    assert.ok(cw().find('.cw-selcount').text().includes('4 字'));
    const inp = cw().find('.cw-selin').get(0);
    inp.value = '改成嘴硬';
    inp.dispatchEvent(new window.Event('input', { bubbles: true }));
    await click('[data-act="localEdit"]');
    assert.ok(draft().personas[0].text.includes('  - 他嘴硬，什么都不认。\n  - 每年春天去旧桥'), draft().personas[0].text);
    const last = prompts.at(-1);
    assert.ok(last.includes('【【他很温柔】】') && last.includes('改成嘴硬') && last.includes('短句，少形容词'));
    assert.ok(cw().find('.cw-changes').text().includes('他很温柔'), '显示原来的');
    assert.ok(cw().find('.cw-add').text().includes('他嘴硬'));
    await click('[data-act="restore"][data-key="persona:迟春"]');
    assert.ok(draft().personas[0].text.includes('他很温柔'));
    draft().style = 0;
});

await check('NPC 页：加一个，写设想，只写这一个', async () => {
    await go('npc');
    const n0 = draft().npcs.length;
    const first = draft().npcs[0]?.content;
    await click('[data-act="add"][data-path="npcs"]');
    assert.equal(draft().npcs.length, n0 + 1);
    type(`input[data-bind="npcs.${n0}.desc"]`, '宫里的老太医');
    await click(`[data-act="npcOne"][data-i="${n0}"]`);
    assert.equal(draft().npcs[n0].name, '秦太医');
    assert.equal(draft().npcs[0].content, first, '别的 NPC 没动');
    assert.ok(prompts.at(-1).includes('宫里的老太医'));
    assert.ok(cw().find(`[data-act="npcOne"][data-i="${n0}"]`).text().includes('重写这个'));
    draft().npcs.splice(n0, 1);
});

await check('规则库：新建一条、插到世界观、关掉；步骤可以关掉；卡的类型；多人卡写关系网', async () => {
    const S = ctx.extensionSettings.cardWorkshop;
    await go('prompts');
    await click('[data-act="ptab"][data-tab="rule"]');
    cw().find('.cw-newrule').val('宫斗写法');
    await click('[data-act="addRule"]');
    assert.equal(S.customRules['宫斗写法'], '');
    type('.cw-rule-ta', '每个势力背后都有一位娘娘。');
    assert.equal(S.customRules['宫斗写法'], '每个势力背后都有一位娘娘。');
    const box = cw().find('.cw-rulestep[data-step="world"]').get(0);
    box.checked = true; box.dispatchEvent(new window.Event('change', { bubbles: true })); await tick();
    assert.deepEqual(S.ruleSteps['宫斗写法'], ['world']);
    await go('world');
    await click('[data-act="world"]');
    assert.ok(prompts.at(-1).includes('【规则·宫斗写法】'));
    await go('prompts');
    await click('[data-act="ptab"][data-tab="rule"]');
    const onBox = cw().find('.cw-rule-on').get(0);
    onBox.checked = false; onBox.dispatchEvent(new window.Event('change', { bubbles: true })); await tick();
    assert.equal(S.ruleOff['宫斗写法'], true);
    await click('[data-act="delRule"]');
    assert.ok(!('宫斗写法' in S.customRules));
    // 关掉“试玩”这一步
    await click('[data-act="ptab"][data-tab="step"]');
    const pg = cw().find('.cw-pageon[data-page="play"]').get(0);
    pg.checked = false; pg.dispatchEvent(new window.Event('change', { bubbles: true })); await tick();
    await go('home');
    assert.equal(cw().find('.cw-tile[data-page="play"]').length, 0, '目录里不显示');
    S.offPages = [];
    // 卡的类型 + 关系网
    await go('tags');
    const ms = cw().find('select[data-bind="mode"]').get(0);
    ms.value = 'multi'; ms.dispatchEvent(new window.Event('change', { bubbles: true })); await tick();
    assert.equal(draft().mode, 'multi');
    draft().personas.push({ name: '守春人', keys: [], overview: '', text: '<守春人>x</守春人>' });
    await go('persona');
    await click('[data-act="relations"]');
    assert.ok(draft().relations.includes('旧账'));
    draft().personas.pop(); draft().relations = ''; draft().mode = '';
});

await check('人设页：加一个主要角色，写设想，名字让 AI 起', async () => {
    await go('persona');
    const n0 = draft().personas.length;
    await click('[data-act="add"][data-path="personas"]');
    assert.equal(draft().personas.length, n0 + 1);
    type(`input[data-bind="personas.${n0}.desc"]`, '守着春神庙的人，知道迟春的秘密');
    await click(`[data-act="persona"][data-i="${n0}"]`);
    assert.equal(draft().personas[n0].name, '守春人');
    assert.ok(draft().personas[n0].text.startsWith('<守春人>'));
    assert.ok(prompts.at(-1).includes('知道迟春的秘密'));
    assert.ok(cw().find('.cw-status').text().includes('守春人 的人设写好了'));
    draft().personas.splice(n0, 1);
});

await check('说明小字：第一次进某页显示，再进就收起；“说明”按钮能临时打开；设置里可以一直显示', async () => {
    const S = ctx.extensionSettings.cardWorkshop;
    S.helpMode = 'first'; S.seenHelp = [];
    await go('npc');
    assert.ok(!cw().hasClass('cw-nohelp'), '第一次进显示');
    await go('home');
    await go('npc');
    assert.ok(cw().hasClass('cw-nohelp'), '再进收起');
    await click('[data-act="toggleHelp"]');
    assert.ok(!cw().hasClass('cw-nohelp'), '点“说明”打开');
    S.helpMode = 'always';
    await go('world');
    assert.ok(!cw().hasClass('cw-nohelp') && !cw().find('[data-act="toggleHelp"]').length);
    S.helpMode = 'never';
    await go('routes');
    assert.ok(cw().hasClass('cw-nohelp'));
    S.helpMode = 'first';
    await go('home');
    const tiles = cw().find('.cw-tile.cw-tool').map((_, el) => el.dataset.page).get();
    assert.deepEqual(tiles, ['settings', 'prompts', 'about'], '提示词在关于前面');
});

await check('开场白页：有路线时也能写不分路线的开场白', async () => {
    await go('greet');
    assert.ok(cw().find('[data-act="showFreeGreet"]').length);
    await click('[data-act="showFreeGreet"]');
    assert.ok(cw().text().includes('不分路线'));
    const n0 = draft().routes.length;
    await click('[data-act="hooks"][data-i="-1"]');
    assert.ok(draft().hooks[''].length);
    assert.equal(draft().routes.length, n0, '没多出路线');
    draft().hooks[''] = [];
});

await check('八股清理不碰基调与规则', async () => {
    await go('check');
    draft().tone = '<创作文体>\n调性: 嘴角勾起一抹若有若无的弧度也不行\n</创作文体>';
    const before = draft().tone;
    await click('[data-act="baguFix"]');
    assert.equal(draft().tone, before);
});

await check('每一页底部都有八股检查：本地扫描、只清理这一页、能换回上一版', async () => {
    await go('world');
    draft().world.main = '<世界观>\n城门口，守卫嘴角勾起一抹若有若无的弧度。\n</世界观>';
    draft().npcs[0].content = '<守庙人>\n他嘴角勾起一抹若有若无的弧度。\n</守庙人>';
    await go('world');
    const bar = cw().find('.cw-bagubar');
    assert.equal(bar.length, 1, '世界观页有八股检查');
    if (withBagu) {
        assert.ok(bar.hasClass('hit'));
        assert.ok(bar.text().includes('世界观'));
        const n = prompts.length;
        await click('[data-act="baguPage"]');
        assert.ok(!draft().world.main.includes('的弧度'), '世界观清理了');
        assert.ok(draft().npcs[0].content.includes('的弧度'), '别的页不动');
        assert.ok(prompts.length > n);
        assert.ok(cw().find('.cw-bagubar').text().includes('改了'), '显示清理结果');
        await click('[data-act="restore"][data-key="world"]');
        assert.ok(draft().world.main.includes('的弧度'), '换回上一版能找回清理前的');
    }
    for (const pg of ['persona', 'npc', 'routes', 'greet', 'intro']) {
        await go(pg);
        assert.equal(cw().find('.cw-bagubar').length, 1, `${pg} 页有八股检查`);
    }
    await go('greet');
    assert.ok(!cw().find('.cw-bagubar').text().includes('基调与规则'));
});

await check('试玩：开始 → 自己发一句 → AI 扮 user 跑一轮 → 点评 → 带着意见去人设页', async () => {
    await go('play');
    assert.ok(title().includes('试玩'));
    await click('[data-act="playStart"]');
    assert.equal(draft().play.messages.length, 1);
    assert.ok(cw().find('.cw-msg.char').length === 1);
    type('textarea[data-bind="play.input"]', '你好');
    await click('[data-act="playSend"]');
    assert.equal(draft().play.messages.length, 3);
    assert.ok(draft().play.messages[2].text.startsWith('迟春看着'));
    type('input[data-bind="play.rounds"]', '1');
    await click('[data-act="playAuto"]');
    assert.equal(draft().play.messages.length, 5);
    assert.equal(draft().play.messages[3].text, '（后退一步）你是谁？');
    assert.ok(cw().text().includes('这一轮发出去的设定'));
    await click('[data-act="playRedo"]');
    assert.equal(draft().play.messages.length, 5);
    await click('[data-act="playCut"]', 1);
    assert.equal(draft().play.messages.length, 2, '删到第 3 条');
    await click('[data-act="playAuto"]');
    await click('[data-act="playReview"]');
    assert.ok(cw().text().includes('6 / 10'));
    await click('[data-act="playFix"]');
    assert.ok(title().includes('主要人设'));
    assert.ok(draft().feedback['persona:迟春'].includes('给他一件自己想做的事'));
    assert.ok(cw().find('input[data-bind="feedback.persona:迟春"]').val().includes('只会接话'));
});

await check('token：大文本框下面有 token 数，目录和导入页有常驻设定合计，超上限标出来', async () => {
    await go('persona');
    const tok = cw().find('.cw-tok[data-tok-path="personas.0.text"]');
    assert.ok(tok.length && /token/.test(tok.text()));
    const before = tok.text();
    type('textarea[data-bind="personas.0.text"]', draft().personas[0].text + '再加很多很多字'.repeat(50));
    assert.notEqual(cw().find('.cw-tok[data-tok-path="personas.0.text"]').text(), before, '打字时跟着变');
    await go('home');
    assert.ok(cw().find('[data-tok-blue]').text().includes('常驻设定'));
    ctx.extensionSettings.cardWorkshop.blueBudget = 10;
    await go('import');
    assert.ok(cw().find('[data-tok-blue]').hasClass('cw-warntext'));
    assert.ok(cw().text().includes('每一块多少'));
    ctx.extensionSettings.cardWorkshop.blueBudget = 4000;
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
    await click('[data-act="planWriteBack"]');
    assert.ok(cw().find('.cw-planchk').length, '列出要写回的地方');
    assert.ok(cw().text().includes('写卡工坊改了的') && cw().text().includes('新加的'));
    assert.ok(cw().find('.cw-planchk[data-id="f:description"]').prop('checked'), '写卡工坊改的默认勾上');
    await click('[data-act="applyWriteBack"]');
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
    // 在酒馆里改了开场白，再在写卡工坊改别的：写回时不会把酒馆里的开场白改回去
    await click('[data-act="planWriteBack"]');
    await click('[data-act="applyWriteBack"]');
    cards['黎曙.png'].data.first_mes = '酒馆里改过的开场';
    draft().personas[0].text = '他是扒手团的孤儿，十年后成了城主，还当了爹。';
    await click('[data-act="planWriteBack"]');
    const g0 = cw().find('.cw-planchk[data-id="g:0"]');
    assert.ok(g0.length && !g0.prop('checked'), '酒馆里改过的开场白默认不勾');
    assert.ok(cw().text().includes('只在酒馆里改过'));
    // 只写人设，不写别的
    cw().find('.cw-planchk').each(function () { if (this.dataset.id !== 'f:description' && this.checked) { this.checked = false; this.dispatchEvent(new window.Event('change', { bubbles: true })); } });
    await tick();
    await click('[data-act="applyWriteBack"]');
    assert.equal(cards['黎曙.png'].data.first_mes, '酒馆里改过的开场', '酒馆里的开场白没被改回去');
    assert.equal(cards['黎曙.png'].data.description, '他是扒手团的孤儿，十年后成了城主，还当了爹。');
    assert.equal(draft().existing.greetings[0], '酒馆里改过的开场', '同步回写卡工坊');
    await click('[data-act="planWriteBack"]');
    assert.ok(!cw().find('.cw-planchk[data-id="g:0"]').length && !cw().find('.cw-planchk[data-id="f:description"]').length, '同步完，不再提示');
});

await check('AU：选卡 → 用这张卡做 AU → 提取内核 → 写设定 → 映射表 → 一键出卡（含一致性检查和修）→ 存成新卡，原卡不动', async () => {
    const origCard = JSON.stringify(cards['黎曙.png']);
    await go('home');
    await click('[data-act="go"][data-page="load"]');
    cw().find('.cw-cardsel').val('黎曙.png');
    await click('[data-act="loadAU"]');
    assert.ok(title().includes('AU 内核与映射'));
    assert.equal(draft().name, '黎曙（AU）');
    assert.ok(!draft().existing);
    await click('[data-act="auCore"]');
    assert.ok(cw().find('textarea[data-bind="au.core.0.text"]').val().includes('放不下'));
    assert.ok(!cw().find('[data-act="auMap"]').length, '没写 AU 设定前不能生成映射表');
    type('textarea[data-bind="idea"]', '现代都市，他是外卖骑手');
    await go('home'); await go('au');
    await click('[data-act="auMap"]');
    assert.ok(draft().au.map.includes('外卖站'));
    const n0 = prompts.length;
    await go('home');
    await click('[data-act="auto"]');
    const ps = prompts.slice(n0);
    assert.ok(!ps.some((p) => p.includes('方向不同的角色卡构想')), 'AU 不出构想');
    const pp = ps.find((p) => p.includes('为角色「黎曙」写人设'));
    assert.ok(pp.includes('【角色内核】') && pp.includes('外卖站'));
    assert.ok(ps.some((p) => p.includes('检查 AU 版人设')), '做了一致性检查');
    assert.ok(ps.some((p) => p.includes('按作者的意见修改') && p.includes('写他替新人兜底')), '按检查结果修了');
    assert.ok(draft().world.main && draft().routes.length && draft().greetings.length);
    await go('persona');
    assert.ok(cw().find('.cw-verdict').length, '人设页显示检查结果');
    await go('import');
    assert.ok(cw().find('[data-act="import"]').length && !cw().find('[data-act="writeBack"]').length, 'AU 只能存成新卡');
    await click('[data-act="import"]');
    const create = requests.filter((r) => r.url === '/api/characters/create').at(-1).body;
    assert.equal(create.ch_name, '黎曙（AU）');
    assert.equal(JSON.stringify(cards['黎曙.png']), origCard, '原卡一点没动');
});

await check('新建草稿：旧的进历史，能读回来', async () => {
    await go('home');
    await click('[data-act="newDraft"]');
    assert.equal(draft().idea, '');
    const s = ctx.extensionSettings.cardWorkshop;
    assert.deepEqual(s.drafts.slice(0, 3).map((x) => x.name), ['黎曙（AU）', '黎曙', '迟春']);
    await click('[data-act="openDraft"]', 2);
    assert.equal(draft().name, '迟春');
    assert.deepEqual(s.drafts.map((x) => x.name), ['黎曙（AU）', '黎曙'], '读回来的草稿离开历史；新建的空草稿不进历史');
});

await check('删除草稿：删一份历史、删当前、清空历史', async () => {
    const s = ctx.extensionSettings.cardWorkshop;
    await click('[data-act="delDraft"]', 0);
    assert.deepEqual(s.drafts.map((x) => x.name), ['黎曙']);
    await click('[data-act="delCurrent"]');
    assert.equal(draft().name, '', '当前草稿换成空的');
    assert.deepEqual(s.drafts.map((x) => x.name), ['黎曙'], '删当前不进历史');
    await click('[data-act="clearDrafts"]');
    assert.equal(s.drafts.length, 0);
    assert.ok(cw().text().includes('没有历史草稿'));
});

await check('填了一半再一键出卡：自己写的人设一个字不动，也不会被换成新角色', async () => {
    if (cw().find('.cw-tile').length === 0) await go('home');
    await click('[data-act="newDraft"]');
    const d = draft();
    d.idea = '最后抱我一次吧';
    const mine = '<守春人>\n我自己写的人设，他嘴角勾起一抹若有若无的弧度\n</守春人>';
    d.personas = [{ name: '守春人', keys: [], overview: '', text: mine }];
    await go('persona');
    await go('home');
    await click('[data-act="auto"]');
    const names = draft().personas.map((p) => p.name);
    assert.ok(names.includes('守春人'), names.join());
    assert.equal(draft().personas.find((p) => p.name === '守春人').text, mine, '自己写的人设不被改写、不被八股清理');
    assert.ok(prompts.some((p) => p.includes('【作者已经写好的内容】') && p.includes('我自己写的人设')), '构想时带上写好的人设');
});

fs.rmSync(tp, { recursive: true, force: true });
console.log(`\n${passed} passed${withBagu ? '（含八股清理联动）' : '（没找到八股清理，跳过联动）'}`);
process.exit(0);
