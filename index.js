// 写卡工坊 · SillyTavern 扩展
// 一句话脑洞 → 构想 → 标签 → 人设 → 世界观 → NPC → 路线 → 基调与规则 → 开场白 → 质检 → 导入 → 简介
import { buildLibrary, toggleTag, tagValue, dimOf } from './src/tags.js';
import { DEFAULT_PROMPTS, DEFAULT_RULES, STEP_INFO, TEMPLATE_VARS } from './src/prompts.js';
import { unshield, findWords } from './src/parse.js';
import { emptyDraft, buildEntries, toWorldData, buildCharacter, uniqueName, orderedGreetings, mapStrings } from './src/assemble.js';
import { makeFlow } from './src/flow.js';
import { callLLM, listProfiles, listPresets } from './src/llm.js';
import { loadBagu, hasBagu, baguOptions, baguScan, baguRewrite } from './src/bagu.js';

const MODULE = 'cardWorkshop';
const VERSION = '0.4.0';
const getCtx = () => SillyTavern.getContext();

const DEFAULTS = {
    version: 1,
    apiProfile: '',
    presetCard: '',
    presetGreeting: '',
    maxTokens: 0,
    useTemperature: true,
    userToken: '<user>',
    personaPlace: 'blue',
    minInterval: 3,
    greetingCount: 2,
    greetingLength: '600–900',
    author: '',
    license: { repost: '不可', edit: '可', commercial: '不可' },
    presetNote: '',
    introNotes: '',
    predictThreshold: 0.42,
    autoPredict: true,
    autoBagu: true,
    prompts: {},
    rules: {},
    customTags: {},
    customSteps: [],
    draft: null,
    drafts: [],
};

const state = { busy: false, abort: false, root: null, page: 'home', checks: null, bagu: null, editStep: 'persona', editRule: '通用', editDim: 'era', ptab: 'step' };

// ───────────── 设置与草稿 ─────────────

function settings() {
    const ext = getCtx().extensionSettings;
    ext[MODULE] ??= {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = structuredClone(v);
    s.license = { ...DEFAULTS.license, ...s.license };
    if (s.personaBlue !== undefined) { if (s.personaBlue) s.personaPlace = 'blue'; delete s.personaBlue; }
    return s;
}
const save = () => getCtx().saveSettingsDebounced();
const lib = () => buildLibrary(settings().customTags);

function draft() {
    const s = settings();
    if (!s.draft) s.draft = emptyDraft();
    const d = s.draft;
    for (const [k, v] of Object.entries(emptyDraft())) if (d[k] === undefined) d[k] = structuredClone(v);
    return d;
}
function saveDraft() { draft().updated = Date.now(); save(); }

const flow = makeFlow({
    settings,
    lib,
    aborted: () => state.abort,
    progress: (m) => setStatus(m),
    llm: (o) => llm(o),
});

/** 所有 API 调用都走这里：计数、429 等待提示、可以停止 */
function llm(o) {
    state.calls = (state.calls ?? 0) + 1;
    state.stepCalls = (state.stepCalls ?? 0) + 1;
    updateCalls();
    return callLLM({
        ...o,
        settings: settings(),
        userToken: settings().userToken || '<user>',
        aborted: () => state.abort,
        onWait: (sec) => setStatus(`API 返回 429（请求太频繁），${sec} 秒后自动重试…`),
    });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
    const ks = path.split('.');
    const last = ks.pop();
    const target = ks.reduce((o, k) => (o[k] ??= {}), obj);
    target[last] = value;
}

// ───────────── 渲染 ─────────────

const btn = (act, label, extra = '') => `<div class="menu_button cw-btn" data-act="${act}" ${extra}>${label}</div>`;
const ta = (path, rows = 6, ph = '') => `<textarea class="text_pole cw-ta" data-bind="${path}" rows="${rows}" placeholder="${esc(ph)}">${esc(getPath(draft(), path) ?? '')}</textarea>`;
const inp = (path, ph = '', cls = '') => `<input class="text_pole cw-in ${cls}" data-bind="${path}" value="${esc(getPath(draft(), path) ?? '')}" placeholder="${esc(ph)}">`;
const listInp = (path, ph = '关键词，逗号分隔') => `<input class="text_pole cw-in" data-bind-list="${path}" value="${esc((getPath(draft(), path) ?? []).join('，'))}" placeholder="${esc(ph)}">`;

/** 每一块下面：修改意见、换回上一版、截断提醒 */
function toolsHtml(key, hasContent = true) {
    const d = draft();
    const n = d.history?.[key]?.length ?? 0;
    const cut = d.truncated?.[key];
    if (!hasContent && !n) return '';
    return `<div class="cw-tools">
${cut ? `<div class="cw-warn">回复可能被截断了（自动续写过一次还不完整）。在“设置”里把最大回复长度调大再重写，或者手动补完。</div>` : ''}
<input class="text_pole cw-in cw-fb" data-bind="feedback.${esc(key)}" value="${esc(d.feedback?.[key] ?? '')}" placeholder="哪里不满意？写在这里，点重写时会带上（可选）">
${n ? `<div class="cw-row">${btn('restore', `换回上一版（存了 ${n} 版）`, `data-key="${esc(key)}"`)}</div>` : ''}
</div>`;
}

function issuesHtml(issues) {
    if (!issues?.length) return '';
    return `<div class="cw-issues">${issues.map((i) => `<span class="cw-issue ${i.level}">${esc(i.label)}${i.match ? `：${esc(i.match)}` : ''}</span>`).join('')}</div>`;
}

/** 选项 + 自己写：点了选项时输入框不重复显示同一句 */
function answerHtml(path, options, ph = '或者自己写') {
    const cur = getPath(draft(), path) ?? '';
    const own = options.includes(cur) ? '' : cur;
    return `<div class="cw-opts">${options.map((o) => `<span class="cw-opt ${cur === o ? 'on' : ''}" data-act="answer" data-path="${path}" data-val="${esc(o)}">${esc(o)}</span>`).join('')}</div>
<input class="text_pole cw-in cw-own" data-bind="${path}" value="${esc(own)}" placeholder="${esc(ph)}">`;
}

// ───────────── 页面：目录 + 二级页 ─────────────

const PAGES = [
    { id: 'idea', name: '一句话构想', desc: '一句话脑洞，或者掷骰子', status: (d) => (d.pick >= 0 && d.concepts[d.pick] ? d.concepts[d.pick].title : d.concepts.length ? `${d.concepts.length} 个构想，还没选` : ''), done: (d) => d.pick >= 0 && !!d.concepts[d.pick] },
    { id: 'tags', name: '标签', desc: '构想时自动勾好，可以再改', status: (d) => d.tags.map((t) => t.name).slice(0, 6).join('、'), done: (d) => d.tags.length > 0 },
    { id: 'persona', name: '主要人设', desc: '先答问题，再生成', status: (d) => d.personas.map((p) => `${p.name}${p.text ? ' ✓' : ''}`).join('、'), done: (d) => d.personas.length > 0 && d.personas.every((p) => p.text) },
    { id: 'world', name: '世界观', status: (d) => (d.world.main ? '已写' : ''), done: (d) => !!d.world.main },
    { id: 'npc', name: 'NPC', status: (d) => (d.npcs.length ? `${d.npcs.length} 个` : ''), done: (d) => d.npcs.length > 0 || d.concepts[d.pick]?.npcs === 0 },
    { id: 'routes', name: '玩家与路线', status: (d) => (d.routes.length ? `${d.routes.filter((r) => r.info).length}/${d.routes.length} 条已写` : ''), done: (d) => d.routes.length > 0 && d.routes.every((r) => r.info) },
    { id: 'tone', name: '基调与规则', desc: '还有自由模块', status: (d) => (d.tone ? '已写' : ''), done: (d) => !!d.tone },
    { id: 'greet', name: '开场白', status: (d) => (d.greetings.length ? `${d.greetings.length} 个` : ''), done: (d) => d.greetings.length > 0 },
    { id: 'check', name: '质检', desc: '本地扫描 · 八股清理', status: () => (state.checks ? '扫描过' : ''), done: () => !!state.checks },
    { id: 'import', name: '导入酒馆', status: (d) => (d.imported ? `已导入：${d.imported.name}` : ''), done: (d) => !!d.imported },
    { id: 'intro', name: '简介', desc: 'Discord 简介和标题', status: (d) => (d.intro?.text ? '已写' : ''), done: (d) => !!d.intro?.text },
];

const nextPage = (d) => PAGES.find((p) => !p.done(d)) ?? null;

function topHtml(inner) {
    return `<div class="cw-top">${inner}
  <div class="cw-row cw-statusrow ${state.busy ? 'busy' : ''}"><span class="cw-spin"></span><span class="cw-status cw-grow"></span><span class="cw-meta cw-dim cw-small"></span><div class="menu_button cw-btn cw-stop" data-act="stop" style="display:${state.busy ? '' : 'none'}">停止</div></div>
</div>`;
}

function updateCalls() {
    if (!state.root) return;
    const sec = state.busy && state.started ? Math.floor((Date.now() - state.started) / 1000) : 0;
    const parts = [];
    if (state.busy) parts.push(`${sec} 秒`);
    if (state.busy || state.stepCalls) parts.push(`这一步调用 ${state.stepCalls ?? 0} 次`);
    if (state.calls) parts.push(`共 ${state.calls} 次`);
    $(state.root).find('.cw-meta').text(parts.join(' · '));
}

function homeHtml() {
    const d = draft();
    const s = settings();
    const hist = (s.drafts ?? []).map((x, i) => `<option value="${i}">${esc(x.name || x.idea?.slice(0, 16) || '未命名')} · ${new Date(x.updated).toLocaleDateString()}</option>`).join('');
    const n = nextPage(d);
    const tile = (p, i) => {
        const st = p.status?.(d) || '';
        return `<div class="cw-tile ${p.done(d) ? 'done' : ''} ${n?.id === p.id ? 'next' : ''}" data-act="go" data-page="${p.id}">
<div class="cw-tn">${i + 1}. ${esc(p.name)}${p.done(d) ? ' <span class="cw-ok">✓</span>' : ''}</div>
<div class="cw-ts">${esc(st || p.desc || '还没开始')}</div></div>`;
    };
    return `${topHtml(`<div class="cw-row"><input class="text_pole cw-in cw-grow" data-bind="name" value="${esc(d.name)}" placeholder="卡名（导入时用）">${btn('newDraft', '新建')}</div>
${hist ? `<select class="text_pole cw-hist"><option value="">历史草稿（${s.drafts.length}）</option>${hist}</select>` : ''}`)}
<div class="cw-next">
  ${n ? `<div class="cw-dim cw-small">下一步</div><div class="menu_button cw-btn cw-primary" data-act="go" data-page="${n.id}">${esc(n.name)} →</div>` : '<div>全部完成了。</div>'}
  <div class="cw-row">${btn('auto', '一键出卡')}<span class="cw-dim cw-small cw-grow">写好一句话后点，自动跑完剩下的步骤；已经写好的不会重写</span></div>
</div>
<div class="cw-grid">${PAGES.map(tile).join('')}
<div class="cw-tile cw-tool" data-act="go" data-page="settings"><div class="cw-tn">设置</div><div class="cw-ts">用哪个 API、写卡预设、开场白预设、调用间隔、人设放哪里</div></div>
<div class="cw-tile cw-tool" data-act="go" data-page="prompts"><div class="cw-tn">提示词</div><div class="cw-ts">每一步的提示词、规则库（禁用词、直接删的词）、我的标签、我的步骤</div></div>
</div>`;
}

function pageHtml(id) {
    const i = PAGES.findIndex((p) => p.id === id);
    const page = PAGES[i];
    const title = page ? `${i + 1}. ${page.name}` : id === 'settings' ? '设置' : '提示词';
    const body = { idea: ideaHtml, tags: tagsHtml, persona: personaHtml, world: worldHtml, npc: npcHtml, routes: routesHtml, tone: toneHtml, greet: greetingHtml, check: checkHtml, import: importHtml, intro: introHtml, prompts: promptsHtml, settings: settingsPageHtml }[id]();
    const prev = PAGES[i - 1];
    const next = PAGES[i + 1];
    return `${topHtml(`<div class="cw-row"><div class="menu_button cw-btn" data-act="go" data-page="home">← 目录</div><b class="cw-grow cw-ptitle">${esc(title)}</b></div>`)}
<div class="cw-page">${body}</div>
<div class="cw-foot">${prev ? `<div class="menu_button cw-btn" data-act="go" data-page="${prev.id}">← ${esc(prev.name)}</div>` : ''}<span class="cw-grow"></span>${next ? `<div class="menu_button cw-btn cw-primary" data-act="go" data-page="${next.id}">下一步：${esc(next.name)} →</div>` : `<div class="menu_button cw-btn" data-act="go" data-page="home">回目录</div>`}</div>`;
}

function ideaHtml() {
    const d = draft();
    let html = `${ta('idea', 3, '一句话脑洞，比如：“最后抱我一次吧，在春天结束之前。”……可春天已在你眼前离去了。')}
<div class="cw-row">${btn('idea', d.concepts.length ? '重新生成构想' : '生成构想')}${btn('inspire', '没想法？掷骰子')}</div>
${toolsHtml('idea', d.concepts.length > 0)}`;
    if (Object.keys(d.dice ?? {}).length || d.inspire?.length) {
        const dice = Object.entries(d.dice ?? {}).map(([k, v]) => `<label class="cw-chip ${d.diceLock?.[k] ? 'on' : ''}"><input type="checkbox" data-act="lockDice" data-dim="${k}" ${d.diceLock?.[k] ? 'checked' : ''}>${esc(dimOf(lib(), k)?.name ?? k)}：${esc(v)}</label>`).join('');
        const qs = (d.inspire ?? []).map((q, i) => `<div class="cw-q"><div class="cw-qt">${esc(q.q)}</div>
${answerHtml(`inspire.${i}.answer`, q.options)}</div>`).join('');
        html += `<div class="cw-box"><div class="cw-sub">骰子 <small class="cw-dim">勾上的“换一批”时不换</small></div><div class="cw-chips">${dice}</div>${qs}
<div class="cw-row">${btn('inspire', '换一批')}<div class="menu_button cw-btn cw-primary" data-act="ideaFromInspire">选好了，用回答生成构想 →</div></div></div>`;
    }
    if (d.fandom || d.check?.length) {
        html += `<div class="cw-box"><div class="cw-sub">同人：${esc(d.fandom)}</div><div class="cw-dim">确认 AI 没记错原作：</div><ul>${d.check.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`;
    }
    html += (d.concepts ?? []).map((c, i) => {
        const picked = d.pick === i;
        return `<div class="cw-card ${picked ? 'picked' : ''}">
<div class="cw-ctitle">${esc(c.title)}</div>
${c.lineup.map((p) => `<div><b>${esc(p.name)}</b>｜${esc(p.identity)}${p.archetype.length ? ` <small class="cw-dim">${esc(p.archetype.join('、'))}</small>` : ''}</div>`).join('')}
${c.user.length ? `<div>〔user〕：${esc(c.user.join(' / '))}</div>` : ''}
<div class="cw-dim">${esc(c.relation)}</div>
${c.tension.core ? `<div>张力：${esc(c.tension.core)}</div>` : ''}
${c.tension.expect.length ? `<div>期待点：${esc(c.tension.expect.join('；'))}</div>` : ''}
<div class="cw-dim">世界观：${esc(c.complexity)}${c.reason ? `（${esc(c.reason)}）` : ''} · 路线：${esc(c.routes.map((r) => r.name).join('、'))} · NPC ${c.npcs}</div>
<div class="cw-row">${picked ? '<span class="cw-badge ok">已选这个</span>' : btn('pick', '选这个', `data-i="${i}"`)}</div>
${picked ? `<details class="cw-mini"><summary>改构想</summary>
${inp(`concepts.${i}.title`, '标题')}
${ta(`concepts.${i}.relation`, 3, '关系与前情')}
${inp(`concepts.${i}.tension.core`, '核心张力')}</details>` : ''}
</div>`;
    }).join('');
    return html;
}

function tagsHtml() {
    const d = draft();
    const L = lib();
    const src = d.tagSrc ?? {};
    const chip = (t, on) => `<span class="cw-chip tag ${on ? 'on' : ''} src-${src[`${t.dim}:${t.name}`] ?? 'user'}" data-act="tag" data-dim="${t.dim}" data-name="${esc(t.name)}">${esc(t.name)}${src[`${t.dim}:${t.name}`] === 'guess' ? '?' : ''}</span>`;
    let html = `<div class="cw-dim cw-small">上面是已选的标签，点一下取消；下面按维度展开，点一下选上。实线框是你那句话里识别到的，虚线框是 AI 推荐的，带问号的是 AI 猜的，确认一下。</div>`;
    html += `<div class="cw-chips">${(d.tags ?? []).map((t) => chip(t, true)).join('') || '<span class="cw-dim">还没有标签</span>'}</div>`;
    if (d.ai?.novel?.length || d.ai?.surprise) {
        html += `<div class="cw-box">`;
        for (const n of d.ai.novel ?? []) html += `<div>新标签：<b>${esc(n.name)}</b>（${esc(dimOf(L, n.dim)?.name ?? n.dim)}） ${btn('adoptTag', '收录并选上', `data-dim="${n.dim}" data-name="${esc(n.name)}"`)}</div>`;
        if (d.ai.surprise) html += `<div>反差推荐：${chip(d.ai.surprise, d.tags.some((t) => t.dim === d.ai.surprise.dim && t.name === d.ai.surprise.name))} <small class="cw-dim">${esc(d.ai.surprise.why)}</small></div>`;
        html += `</div>`;
    }
    html += L.map((dim) => `<details class="cw-mini"><summary>${esc(dim.name)}${dim.single ? '（单选）' : ''} <small class="cw-dim">${esc(tagValue(d.tags, dim.key).join('、'))}</small></summary>
<div class="cw-chips">${dim.tags.map((t) => chip(t, d.tags.some((x) => x.dim === t.dim && x.name === t.name))).join('')}</div></details>`).join('');
    return html;
}

/** 人设里的禁用词和八股，生成完就能看到 */
function clicheHtml(text, i) {
    if (!String(text ?? '').trim()) return '';
    const words = findWords(text, flow.banned(draft()));
    const opts = hasBagu() ? baguOptions(getCtx().extensionSettings, flow.banned(draft())) : null;
    const scan = opts ? baguScan(text, opts) : null;
    if (!words.length && !scan?.total) return '<div class="cw-small"><span class="cw-badge ok">没有禁用词和八股</span></div>';
    return `<div class="cw-box cw-small">${words.length ? `<div>禁用词：<b class="cw-err">${esc(words.join('、'))}</b></div>` : ''}${scan?.total ? `<div>八股 ${scan.total} 处：${esc(scan.top.slice(0, 6).map((h) => h.label).join('、'))}</div>` : ''}
${hasBagu() ? `<div class="cw-row">${btn('baguOne', '只清理这个人设', `data-i="${i}"`)}</div>` : ''}</div>`;
}

function personaHtml() {
    const d = draft();
    if (!d.personas?.length) return '<div class="cw-dim">先选一个构想。</div>';
    let html = `<div class="cw-row">${btn('qa', d.qa?.chars?.length ? '换一批问题' : '出问题（给脑洞）')}${btn('allPersonas', '生成全部人设')}</div>`;
    (d.qa?.chars ?? []).forEach((c, ci) => {
        html += `<div class="cw-box"><div class="cw-sub">${esc(c.name)} 的问题</div>${c.questions.map((q, qi) => `<div class="cw-q"><div class="cw-qt">${esc(q.q)}</div>
${answerHtml(`qa.chars.${ci}.questions.${qi}.answer`, q.options, '或者自己写；留空让 AI 决定')}</div>`).join('')}</div>`;
    });
    const place = settings().personaPlace;
    d.personas.forEach((p, i) => {
        const pr = d.predict?.[p.name];
        html += `<div class="cw-card">
<div class="cw-row">${inp(`personas.${i}.name`, '名字', 'cw-grow')}${btn('persona', p.text ? '重写' : '生成', `data-i="${i}"`)}</div>
${listInp(`personas.${i}.keys`, '别名/称呼（绿灯关键词，逗号分隔）')}
${toolsHtml(`persona:${p.name}`, !!p.text)}
<div class="cw-sub">概要 <small class="cw-dim">${place === 'green' ? '蓝灯常驻' : '给后面步骤参考，不单独导入'}</small></div>${ta(`personas.${i}.overview`, 3)}
<div class="cw-sub">人设 <small class="cw-dim">${{ blue: '世界书 · 蓝灯常驻', green: '世界书 · 绿灯', description: '导入到角色描述' }[place] ?? ''}（在“设置”里改）</small></div>${ta(`personas.${i}.text`, 14)}
${clicheHtml(p.text, i)}
<div class="cw-row">${btn('predict', pr ? '再测一次' : '可预测性测试', `data-i="${i}"`)}${pr?.overlaps?.length ? btn('destale', `重写撞车的 ${pr.overlaps.length} 处`, `data-i="${i}" class="cw-primary"`) : ''}</div>
<div class="cw-dim cw-small">先让 AI 只看标签猜这类角色的刻板写法，再按意思比对人设。2 次调用。</div>
${pr ? `<div class="cw-box cw-small">${pr.rewritten ? '<span class="cw-badge ok">撞车的部分已重写，可以再测一次</span>' : pr.overlaps.length ? pr.overlaps.map((o) => `<div class="cw-ov">卡里：<b>${esc(o.card)}</b><br><span class="cw-dim">撞上的刻板写法：${esc(o.text)}</span></div>`).join('') : '<span class="cw-badge ok">没撞上</span>'}
${pr.predicted ? `<details class="cw-mini"><summary>AI 猜的刻板写法</summary>${[...(pr.predicted.scenes ?? []).map((sc) => `${sc.scene}：${sc.behavior ?? ''}${sc.line ? `「${sc.line}」` : ''}`), ...(pr.predicted.traits ?? [])].map((x) => `<div>· ${esc(x)}</div>`).join('')}</details>` : ''}</div>` : ''}
</div>`;
    });
    return html;
}

function worldHtml() {
    const d = draft();
    return `<div class="cw-row">${btn('world', d.world.main ? '重写' : '生成世界观')}</div>
${toolsHtml('world', !!d.world.main)}
<div class="cw-sub">总览 <small class="cw-dim">蓝灯</small></div>${ta('world.main', 10)}
${d.world.extra.map((e, i) => `<div class="cw-card"><div class="cw-row">${inp(`world.extra.${i}.name`, '名称', 'cw-grow')}${btn('del', '删', `data-path="world.extra" data-i="${i}"`)}</div>${listInp(`world.extra.${i}.keys`, '关键词（空着就是蓝灯）')}${ta(`world.extra.${i}.content`, 6)}</div>`).join('')}
<div class="cw-row">${btn('add', '加一个条目', 'data-path="world.extra" data-tpl="extra"')}</div>`;
}

function npcHtml() {
    const d = draft();
    return `<div class="cw-row">${btn('npc', d.npcs.length ? '重写全部' : '生成 NPC')}${btn('add', '手动加一个', 'data-path="npcs" data-tpl="npc"')}</div>
${toolsHtml('npc', d.npcs.length > 0)}
${d.npcs.map((n, i) => `<div class="cw-card"><div class="cw-row">${inp(`npcs.${i}.name`, '名字', 'cw-grow')}${btn('del', '删', `data-path="npcs" data-i="${i}"`)}</div>${listInp(`npcs.${i}.keys`)}${ta(`npcs.${i}.content`, 7)}</div>`).join('')}`;
}

function routesHtml() {
    const d = draft();
    return `<div class="cw-dim cw-small">每条路线 = 一个〔user〕身份 + 一个时期。导入时只启用第一条，其余在“导入”里切换。</div>
<div class="cw-row">${btn('routes', '生成路线信息')}${btn('add', '加一条路线', 'data-path="routes" data-tpl="route"')}</div>
${toolsHtml('routes', d.routes.some((r) => r.info))}
${d.routes.map((r, i) => `<div class="cw-card"><div class="cw-row">${inp(`routes.${i}.name`, '路线名', 'cw-grow')}${btn('del', '删', `data-path="routes" data-i="${i}"`)}</div>
<div class="cw-row">${inp(`routes.${i}.user`, '〔user〕身份', 'cw-grow')}${inp(`routes.${i}.period`, '时期', 'cw-grow')}</div>
${ta(`routes.${i}.info`, 8, '<玩家信息>…</玩家信息>\n<关系指导>…</关系指导>')}</div>`).join('')}`;
}

function toneHtml() {
    const d = draft();
    const steps = settings().customSteps ?? [];
    return `<div class="cw-row">${btn('tone', d.tone ? '重写' : '生成基调与规则')}</div>
${toolsHtml('tone', !!d.tone)}
<div class="cw-sub">创作文体 <small class="cw-dim">蓝灯，放在角色定义之前</small></div>${ta('tone', 10)}
<div class="cw-sub">自由模块 <small class="cw-dim">系统面板、信物、预言……上面没覆盖的都放这里</small></div>
${d.free.map((f, i) => `<div class="cw-card"><div class="cw-row">${inp(`free.${i}.name`, '模块名', 'cw-grow')}${btn('free', '生成', `data-i="${i}"`)}${btn('del', '删', `data-path="free" data-i="${i}"`)}</div>
${inp(`free.${i}.desc`, '几句话描述它是什么')}
${f.name ? toolsHtml(`free:${f.name.trim()}`, !!f.content) : ''}
<div class="cw-row"><select class="text_pole" data-bind="free.${i}.light"><option value="blue" ${f.light !== 'green' ? 'selected' : ''}>蓝灯常驻</option><option value="green" ${f.light === 'green' ? 'selected' : ''}>绿灯（关键词触发）</option></select>
<select class="text_pole" data-bind="free.${i}.position"><option value="after" ${f.position !== 'before' ? 'selected' : ''}>角色定义之后</option><option value="before" ${f.position === 'before' ? 'selected' : ''}>角色定义之前</option></select></div>
${listInp(`free.${i}.keys`)}${ta(`free.${i}.content`, 6)}</div>`).join('')}
<div class="cw-row">${btn('add', '加一个模块', 'data-path="free" data-tpl="free"')}</div>
${steps.length ? `<div class="cw-sub">我的步骤</div><div class="cw-row">${steps.map((st, i) => btn('custom', esc(st.name || `步骤${i + 1}`), `data-i="${i}"`)).join('')}</div>` : '<div class="cw-dim cw-small">想加自己的步骤：目录 → 提示词 → 我的步骤。</div>'}`;
}

function greetingHtml() {
    const d = draft();
    const s = settings();
    const routes = d.routes.length ? d.routes : [{ name: '主线' }];
    const presets = listPresets();
    return `<label class="cw-presetpick">开场白预设<select class="text_pole cw-in" data-set="presetGreeting"><option value="">不用预设</option>${presets.map((p) => `<option value="${esc(p)}" ${p === s.presetGreeting ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
<div class="cw-dim cw-small">${presets.length ? '选你平时玩卡用的正文预设，插件会把它打开的条目一起发出去，不会切换你酒馆当前的预设。' : '列表是空的：要先在酒馆里用“对话补全”类 API，才能读到预设。'}每条路线 ${s.greetingCount} 个，重写会替换这条路线原来的开场白（可以换回上一版）。</div>
${routes.map((r, i) => {
        const list = (d.greetings ?? []).map((g, gi) => ({ g, gi })).filter((x) => x.g.route === r.name);
        return `<div class="cw-card"><div class="cw-row"><b class="cw-grow">${esc(r.name)}</b>${btn('greet', list.length ? '重写这条线' : '生成', `data-i="${i}"`)}</div>
${toolsHtml(`greet:${r.name}`, list.length > 0)}
${list.map(({ gi }) => `<div class="cw-row cw-end">${btn('del', '删', `data-path="greetings" data-i="${gi}"`)}</div>${ta(`greetings.${gi}.text`, 10)}`).join('')}</div>`;
    }).join('')}
<div class="cw-dim cw-small">第一条路线的第一个开场白会成为主开场白，其余按路线顺序放进额外开场白。</div>`;
}

function checkHtml() {
    const s = settings();
    const r = state.checks;
    const b = state.bagu;
    const ext = getCtx().extensionSettings;
    const opts = hasBagu() ? baguOptions(ext) : null;
    let html = `<div class="cw-row">${btn('localCheck', '本地扫描')}${hasBagu() ? btn('baguScan', '扫描八股') + btn('baguFix', '八股清理改写') : ''}</div>
<div class="cw-dim cw-small">${hasBagu() ? `已连接八股清理（${opts.rules.length} 条规则，我的八股词 ${String(ext.baguCleaner?.userWords ?? '').split('\n').filter((x) => x.trim()).length} 个）` : '没检测到八股清理扩展。装好后刷新酒馆就会自动联动。'}</div>`;
    if (r) {
        html += r.sections.length ? r.sections.map((x) => `<div class="cw-box"><div class="cw-sub">${esc(x.label)}</div>${issuesHtml(x.issues)}</div>`).join('') : '<span class="cw-badge ok">本地扫描没发现问题</span>';
        if (r.cross.length) html += `<div class="cw-box"><div class="cw-sub">主要角色太像了</div>${r.cross.map((c) => `<div>${esc(c.a)} 和 ${esc(c.b)}：${c.count} 处相似${c.pairs.map((p) => `<div class="cw-small cw-dim">「${esc(p.a)}」≈「${esc(p.b)}」</div>`).join('')}</div>`).join('')}</div>`;
    }
    if (b) html += `<div class="cw-box">${b.map((x) => `<div>${esc(x.label)}：${x.text}</div>`).join('')}</div>`;
    html += `<div class="cw-dim cw-small">可预测性测试在“主要人设”里每个角色下面。阈值 ${s.predictThreshold}，在设置里改。</div>`;
    return html;
}

function importHtml() {
    const d = draft();
    const es = buildEntries(d, { personaPlace: settings().personaPlace });
    const gs = orderedGreetings(d);
    const im = d.imported;
    return `<div class="cw-small">将创建世界书 <b>${esc(d.name || '新角色')}</b>（${es.length} 个条目）和角色卡（主开场白 + ${Math.max(0, gs.length - 1)} 个额外开场白），并绑定。</div>
<details class="cw-mini"><summary>条目预览</summary>${es.map((e) => `<div class="cw-small">${e.constant ? '🔵' : '🟢'} ${esc(e.comment)} <span class="cw-dim">${e.position === 0 ? '角色前' : '角色后'} · 顺序 ${e.order}${e.disable ? ' · 未启用' : ''}${e.key?.length ? ` · ${esc(e.key.join('、'))}` : ''}</span></div>`).join('')}
${gs.map((g, i) => `<div class="cw-small">${i === 0 ? '主开场白' : `额外开场白 ${i}`}：${esc(g.route)}</div>`).join('')}</details>
<div class="cw-row">${btn('import', im ? '再导入一张新的' : '导入酒馆')}${btn('exportDraft', '导出草稿')}${btn('importDraft', '读取草稿')}</div>
${im ? `<div class="cw-box"><div>已导入：角色 <b>${esc(im.name)}</b>${im.world ? `，世界书 <b>${esc(im.world)}</b>` : ''}</div>
${d.routes.length > 1 ? `<div class="cw-row"><select class="text_pole cw-grow cw-route">${d.routes.map((r, i) => `<option value="${i}">${esc(r.name)}</option>`).join('')}</select>${btn('switchRoute', '切换到这条路线')}</div>` : ''}</div>` : ''}`;
}

function introHtml() {
    const d = draft();
    const it = d.intro ?? {};
    const len = [...String(it.text ?? '')].length;
    return `<div class="cw-row">${btn('intro', it.text ? '重写简介' : '生成简介')}</div>
${toolsHtml('intro', !!it.text)}
${it.titles?.length ? `<div class="cw-opts">${it.titles.map((t, i) => `<span class="cw-opt ${i === (it.pick ?? 0) ? 'on' : ''}" data-act="pickTitle" data-i="${i}">${esc(t)}</span>`).join('')}</div>` : ''}
${ta('intro.text', 16)}
<div class="cw-row"><span class="cw-dim cw-grow cw-len">${len} 字${len > 2000 ? '（超过 2000，非 Nitro 要拆两条）' : ''}</span>${btn('copyIntro', '复制')}${btn('saveIntro', '写进角色卡')}</div>
<div class="cw-dim cw-small">作者名、授权、预设参考在扩展设置里填。</div>`;
}

const STEP_TEMPLATE = '【任务】为这张卡写……\n\n【构想】\n{{concept}}\n【主要角色概要】\n{{overviews}}\n\n【写法规则】\n{{rules.通用}}';

function promptsHtml() {
    const s = settings();
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const tabs = [['step', '每一步的提示词'], ['rule', '规则库'], ['tag', '我的标签'], ['mine', '我的步骤']];
    let body = '';
    if (state.ptab === 'step') {
        const id = state.editStep;
        body = `<div class="cw-dim cw-small">选一个步骤，直接在框里改或者整段粘贴你自己的提示词，自动保存。改坏了点“恢复默认”。用 {{变量}} 引用前面步骤的产出，下面有列表。</div>
<select class="text_pole cw-step-sel">${Object.keys(DEFAULT_PROMPTS).map((k) => opt(k, `${STEP_INFO[k]?.name ?? k}${s.prompts[k]?.trim() ? '（已改）' : ''}`, id)).join('')}</select>
<textarea class="text_pole cw-ta cw-step-ta" rows="16">${esc(s.prompts[id]?.trim() ? s.prompts[id] : DEFAULT_PROMPTS[id])}</textarea>
<div class="cw-row">${btn('resetStep', '恢复这一步的默认')}</div>
<details class="cw-mini"><summary>可用变量</summary><div class="cw-small">${Object.entries(TEMPLATE_VARS).map(([k, v]) => `<code>{{${esc(k)}}}</code> ${esc(v)}`).join('<br>')}</div></details>`;
    } else if (state.ptab === 'rule') {
        const k = state.editRule;
        body = `<div class="cw-dim cw-small">规则库被多个步骤共用（提示词里写 {{rules.名称}} 的地方），改一处全部生效。你教程里的写法规则可以直接粘进来。</div>
<select class="text_pole cw-rule-sel">${Object.keys(DEFAULT_RULES).map((r) => opt(r, `${r}${s.rules[r]?.trim() ? '（已改）' : ''}`, k)).join('')}</select>
<textarea class="text_pole cw-ta cw-rule-ta" rows="14">${esc(s.rules[k]?.trim() ? s.rules[k] : DEFAULT_RULES[k])}</textarea>
<div class="cw-row">${btn('resetRule', '恢复这条规则的默认')}</div>`;
    } else if (state.ptab === 'tag') {
        body = `<div class="cw-dim cw-small">每行一个：名称|触发词,触发词。触发词出现在一句话脑洞里就自动勾上。</div>
<select class="text_pole cw-dim-sel">${lib().map((d) => opt(d.key, d.name, state.editDim)).join('')}</select>
<textarea class="text_pole cw-ta cw-dim-ta" rows="6" placeholder="蒸汽朋克|蒸汽,齿轮城">${esc((s.customTags[state.editDim] ?? []).join('\n'))}</textarea>`;
    } else {
        body = `<div class="cw-dim cw-small">自己加的步骤会在“基调与规则”页里出现一个按钮，产出写成一个自由模块，导入时进世界书。</div>
${(s.customSteps ?? []).map((st, i) => `<div class="cw-card">
<input class="text_pole cw-in" data-step="${i}" data-key="name" value="${esc(st.name)}" placeholder="步骤名（也是模块名）">
<div class="cw-row"><select class="text_pole" data-step="${i}" data-key="stage">${opt('card', '用写卡预设', st.stage)}${opt('greeting', '用开场白预设', st.stage)}</select>
<select class="text_pole" data-step="${i}" data-key="light">${opt('blue', '蓝灯', st.light)}${opt('green', '绿灯', st.light)}</select>
<select class="text_pole" data-step="${i}" data-key="position">${opt('after', '角色后', st.position)}${opt('before', '角色前', st.position)}</select></div>
<input class="text_pole cw-in" data-step="${i}" data-key="keys" value="${esc((st.keys ?? []).join('，'))}" placeholder="绿灯关键词">
<textarea class="text_pole cw-ta" rows="8" data-step="${i}" data-key="template">${esc(st.template)}</textarea>
<div class="cw-row cw-end">${btn('delStep', '删除这个步骤', `data-i="${i}"`)}</div></div>`).join('')}
<div class="cw-row">${btn('addStep', '加一个步骤')}</div>`;
    }
    return `<div class="cw-tabs">${tabs.map(([k, n]) => `<span class="cw-tab ${state.ptab === k ? 'on' : ''}" data-act="ptab" data-tab="${k}">${n}</span>`).join('')}</div>${body}`;
}

function renderAll() {
    if (!state.root) return;
    state.root.innerHTML = `<div class="cw">${state.page === 'home' ? homeHtml() : pageHtml(state.page)}</div>`;
    setBusy(state.busy);
    setStatus(state.lastStatus ?? `写卡工坊 v${VERSION}`);
}

function setStatus(msg) {
    state.lastStatus = msg;
    if (state.root) $(state.root).find('.cw-status').html(msg);
}
function setBusy(b) {
    state.busy = b;
    clearInterval(state.timer);
    if (b) state.timer = setInterval(updateCalls, 1000);
    if (!state.root) return;
    $(state.root).find('.cw-statusrow').toggleClass('busy', b);
    updateCalls();
    $(state.root).find('[data-act]').not('[data-act="stop"],[data-act="lockDice"],[data-act="go"]').toggleClass('disabled', b);
    $(state.root).find('.cw-stop').toggle(b);
}

// ───────────── 动作 ─────────────

async function step(fn, done = '') {
    if (state.busy) return;
    state.abort = false;
    state.started = Date.now();
    state.stepCalls = 0;
    setBusy(true);
    try {
        const msg = await fn();
        saveDraft();
        state.lastStatus = (typeof msg === 'string' && msg) || done || '完成。';
    } catch (e) {
        console.error('[写卡工坊]', e);
        state.lastStatus = `<span class="cw-err">${esc(e?.message || e)}</span>`;
        if (!state.abort) toastr.error(String(e?.message || e), '写卡工坊');
        saveDraft();
    } finally {
        state.busy = false;
        renderAll();
    }
}

const TEMPLATES = {
    extra: () => ({ name: '', keys: [], content: '' }),
    npc: () => ({ name: '', keys: [], content: '' }),
    route: () => ({ name: `路线${draft().routes.length + 1}`, user: '', period: '', info: '' }),
    free: () => ({ name: '', desc: '', content: '', light: 'blue', keys: [], position: 'after' }),
};

async function autoRun() {
    const d = draft();
    const s = settings();
    if (!d.idea.trim() && !d.concepts.length) {
        toastr.info('先写一句话脑洞，或者点“没想法？掷骰子”', '写卡工坊');
        return;
    }
    await step(async () => {
        const tick = () => { saveDraft(); renderAll(); setBusy(true); };
        if (!d.concepts.length) { await flow.idea(d); tick(); }
        if (d.pick < 0 || !d.concepts[d.pick]) { flow.pickConcept(d, 0); tick(); }
        for (const p of d.personas) if (!p.text) { setStatus(`人设：${esc(p.name)}…`); await flow.persona(d, p.name); tick(); }
        if (!d.world.main) { await flow.world(d); tick(); }
        if (!d.npcs.length && (d.concepts[d.pick]?.npcs ?? 0) > 0) { await flow.npc(d); tick(); }
        if (d.routes.some((r) => !r.info)) { await flow.routes(d); tick(); }
        if (!d.tone) { await flow.tone(d); tick(); }
        for (let i = 0; i < d.routes.length; i++) {
            if (!d.greetings.some((g) => g.route === d.routes[i].name)) { setStatus(`开场白：${esc(d.routes[i].name)}…`); await flow.greetings(d, i); tick(); }
        }
        if (s.autoPredict) {
            for (const p of d.personas) {
                setStatus(`可预测性测试：${esc(p.name)}…`);
                const r = await flow.predict(d, p.name);
                if (r.overlaps.length) await flow.destale(d, p.name);
                tick();
            }
        }
        if (s.autoBagu && hasBagu()) { await baguFix(); tick(); }
        state.checks = flow.localCheck(d);
        state.page = 'check';
    }, '一键出卡完成。看一下质检结果，没问题就导入。');
}

async function baguFix() {
    const ext = getCtx().extensionSettings;
    const opts = baguOptions(ext, flow.banned(draft()));
    const report = [];
    for (const slot of flow.textSlots(draft())) {
        if (state.abort) break;
        const scan = baguScan(slot.get(), opts);
        if (!scan.total) continue;
        setStatus(`八股清理：${esc(slot.label)}…`);
        const r = await baguRewrite(slot.get(), slot.kind, opts,
            (system, user) => llm({ system, user, stage: 'card' }),
            () => state.abort);
        slot.set(r.text);
        report.push({ label: slot.label, text: `改了 ${r.changed} 句${r.failed.length ? `，${r.failed.length} 句没改好：${esc(r.failed.join('、'))}` : ''}` });
    }
    state.bagu = report.length ? report : [{ label: '八股清理', text: '没有需要改的句子' }];
}

let WI = null;
/** 旧版酒馆的 context 里没有世界书函数时，直接从 world-info.js 拿 */
async function worldApi() {
    const c = getCtx();
    if (!WI) { try { WI = await import('../../../world-info.js'); } catch { WI = {}; } }
    return {
        names: () => c.getWorldInfoNames?.() ?? [...(WI.world_names ?? [])],
        load: (n) => (c.loadWorldInfo ?? WI.loadWorldInfo)(n),
        save: (n, data) => (c.saveWorldInfo ?? WI.saveWorldInfo)(n, data, true),
        refresh: () => (c.updateWorldInfoList ?? WI.updateWorldInfoList)?.(),
        reload: (n) => { try { (c.reloadWorldInfoEditor ?? WI.reloadEditor)?.(n); } catch { /* 编辑器没开 */ } },
    };
}

async function importToTavern() {
    const c = getCtx();
    const s = settings();
    const d = draft();
    const token = s.userToken || '<user>';
    const clean = mapStrings(structuredClone(d), (x) => unshield(x, token));
    const entries = buildEntries(clean, { personaPlace: s.personaPlace });
    if (!entries.length && !orderedGreetings(clean).length) { toastr.warning('还没有内容可以导入', '写卡工坊'); return; }
    const ok = await c.callGenericPopup(`导入“${esc(d.name || '新角色')}”：世界书 ${entries.length} 个条目，开场白 ${orderedGreetings(clean).length} 个。`, c.POPUP_TYPE.CONFIRM);
    if (!ok) return;
    await step(async () => {
        const W = await worldApi();
        const worldName = uniqueName(d.name || '新角色', W.names());
        if (entries.length) {
            await W.save(worldName, toWorldData(entries));
            await W.refresh();
        }
        const body = buildCharacter(clean, { worldName: entries.length ? worldName : '', creator: s.author, intro: clean.intro?.text ?? '', personaPlace: s.personaPlace });
        const res = await fetch('/api/characters/create', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`创建角色失败（HTTP ${res.status}）：${await res.text()}`);
        const avatar = await res.text();
        await c.getCharacters();
        const idx = c.characters.findIndex((x) => x.avatar === avatar);
        if (idx >= 0) await c.selectCharacterById(idx);
        d.imported = { avatar, world: entries.length ? worldName : '', name: body.ch_name, time: Date.now() };
        toastr.success(`已导入：${body.ch_name}`, '写卡工坊');
    }, '已导入酒馆。开场白在角色卡里，世界书已绑定。');
}

async function switchRoute(i) {
    const d = draft();
    const r = d.routes[i];
    if (!d.imported?.world || !r) return;
    await step(async () => {
        const W = await worldApi();
        const data = await W.load(d.imported.world);
        let n = 0;
        for (const e of Object.values(data?.entries ?? {})) {
            if (!String(e.comment ?? '').startsWith('路线·')) continue;
            e.disable = e.comment !== `路线·${r.name}`;
            n++;
        }
        if (!n) throw new Error('世界书里没找到路线条目');
        await W.save(d.imported.world, data);
        W.reload(d.imported.world);
    }, `已切换到路线“${esc(r.name)}”。开新聊天时选对应的开场白。`);
}

function download(name, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function pushHistory() {
    const s = settings();
    const d = s.draft;
    if (!d || (!d.idea?.trim() && !d.concepts?.length)) return;
    s.drafts = [structuredClone(d), ...(s.drafts ?? []).filter((x) => x.id !== d.id)].slice(0, 8);
}

const ACTIONS = {
    go: (el) => {
        state.page = el.dataset.page || 'home';
        if (!state.busy) state.lastStatus = '';
        renderAll();
        const box = state.root?.closest?.('.popup-content, .popup-body, dialog');
        try { box?.scrollTo?.(0, 0); state.root?.scrollIntoView?.({ block: 'start' }); } catch { /* ignore */ }
    },
    ptab: (el) => { state.ptab = el.dataset.tab; renderAll(); },
    restore: (el) => {
        if (flow.restore(draft(), el.dataset.key)) { saveDraft(); state.lastStatus = '换回上一版了。再点一次会继续往前换，换一圈回到最新的。'; renderAll(); }
    },
    resetStep: () => { settings().prompts[state.editStep] = ''; save(); renderAll(); },
    resetRule: () => { settings().rules[state.editRule] = ''; save(); renderAll(); },
    addStep: () => {
        settings().customSteps.push({ id: `step${Date.now().toString(36)}`, name: '', stage: 'card', light: 'blue', position: 'after', keys: [], template: STEP_TEMPLATE, output: 'free' });
        save(); renderAll();
    },
    delStep: (el) => { settings().customSteps.splice(Number(el.dataset.i), 1); save(); renderAll(); },
    stop: () => {
        state.abort = true;
        try { getCtx().stopGeneration?.(); } catch { /* ignore */ }
        setStatus('正在停止…');
    },
    newDraft: async () => {
        const c = getCtx();
        if (!(await c.callGenericPopup('新建一张卡？当前草稿会放进历史草稿。', c.POPUP_TYPE.CONFIRM))) return;
        pushHistory();
        settings().draft = emptyDraft();
        state.checks = null; state.bagu = null; state.page = 'home';
        saveDraft(); renderAll();
    },
    auto: autoRun,
    idea: () => {
        const d = draft();
        if (!d.idea.trim()) return toastr.info('先写一句话脑洞', '写卡工坊');
        return step(() => flow.idea(d), '下面三个构想选一个，标签已经自动勾好了。');
    },
    inspire: () => step(() => flow.inspire(draft()), '点选或自己写答案，然后“用这些回答生成构想”。'),
    ideaFromInspire: () => {
        const d = draft();
        flow.ideaFromInspire(d);
        if (!d.idea.trim()) return toastr.info('先回答至少一个问题', '写卡工坊');
        return step(() => flow.idea(d), '选一个构想。');
    },
    lockDice: (el) => {
        const d = draft();
        d.diceLock ??= {};
        if (el.checked) d.diceLock[el.dataset.dim] = d.dice[el.dataset.dim]; else delete d.diceLock[el.dataset.dim];
        saveDraft();
    },
    answer: (el) => {
        const d = draft();
        const cur = getPath(d, el.dataset.path);
        setPath(d, el.dataset.path, cur === el.dataset.val ? '' : el.dataset.val);
        saveDraft(); renderAll();
    },
    pick: (el) => {
        flow.pickConcept(draft(), Number(el.dataset.i));
        state.lastStatus = '选好了。点底部“下一步”继续，或者回目录点“一键出卡”。';
        saveDraft(); renderAll();
    },
    tag: (el) => {
        const d = draft();
        const { dim, name } = el.dataset;
        const on = !d.tags.some((t) => t.dim === dim && t.name === name);
        d.tags = toggleTag(d.tags, lib(), dim, name, on);
        if (on) { d.tagSrc ??= {}; d.tagSrc[`${dim}:${name}`] ??= 'user'; }
        saveDraft(); renderAll();
    },
    adoptTag: (el) => {
        const s = settings();
        const d = draft();
        const { dim, name } = el.dataset;
        s.customTags[dim] = [...(s.customTags[dim] ?? []), `${name}|${name}`];
        d.tags = toggleTag(d.tags, lib(), dim, name, true);
        d.ai.novel = d.ai.novel.filter((n) => n.name !== name);
        saveDraft(); renderAll();
    },
    qa: () => step(() => flow.qa(draft()), '点选答案或自己写，然后生成人设。'),
    persona: (el) => { const p = draft().personas[Number(el.dataset.i)]; return step(() => flow.persona(draft(), p.name), `${esc(p.name)} 的人设写好了。`); },
    allPersonas: () => step(async () => { for (const p of draft().personas) { setStatus(`人设：${esc(p.name)}…`); await flow.persona(draft(), p.name); saveDraft(); } }, '人设都写好了。'),
    predict: (el) => { const p = draft().personas[Number(el.dataset.i)]; return step(() => flow.predict(draft(), p.name), '测试完了，结果在角色下面。'); },
    destale: (el) => { const p = draft().personas[Number(el.dataset.i)]; return step(() => flow.destale(draft(), p.name), '撞车的部分重写了，已重新比对。'); },
    world: () => step(() => flow.world(draft()), '世界观写好了。'),
    npc: () => step(() => flow.npc(draft()), 'NPC 写好了。'),
    routes: () => step(() => flow.routes(draft()), '路线信息写好了。'),
    tone: () => step(() => flow.tone(draft()), '基调与规则写好了。'),
    free: (el) => step(() => flow.free(draft(), Number(el.dataset.i)), '模块写好了。'),
    custom: (el) => { const st = settings().customSteps[Number(el.dataset.i)]; return step(() => flow.custom(draft(), st), `${esc(st.name)} 完成，产出在自由模块里。`); },
    greet: (el) => step(() => flow.greetings(draft(), Number(el.dataset.i)), '开场白写好了。'),
    add: (el) => { getPath(draft(), el.dataset.path).push(TEMPLATES[el.dataset.tpl]()); saveDraft(); renderAll(); },
    del: (el) => { getPath(draft(), el.dataset.path).splice(Number(el.dataset.i), 1); saveDraft(); renderAll(); },
    localCheck: () => { state.checks = flow.localCheck(draft()); renderAll(); },
    baguScan: () => {
        const opts = baguOptions(getCtx().extensionSettings, flow.banned(draft()));
        state.bagu = flow.textSlots(draft()).map((s) => ({ s, r: baguScan(s.get(), opts) })).filter((x) => x.r.total)
            .map((x) => ({ label: x.s.label, text: `${x.r.must ? `<b class="cw-err">必改 ${x.r.must}</b> · ` : ''}八股 ${x.r.total} 处：${x.r.top.slice(0, 6).map((h) => esc(h.label)).join('、')}` }));
        if (!state.bagu.length) state.bagu = [{ label: '八股清理', text: '没扫到八股' }];
        renderAll();
    },
    baguFix: () => step(baguFix, '八股清理完成。'),
    baguOne: (el) => step(async () => {
        const p = draft().personas[Number(el.dataset.i)];
        const opts = baguOptions(getCtx().extensionSettings, flow.banned(draft()));
        const r = await baguRewrite(p.text, '人设', opts, (system, user) => llm({ system, user, stage: 'card' }), () => state.abort);
        p.text = r.text;
        return `改了 ${r.changed} 句${r.failed.length ? `，${r.failed.length} 句没改好，可以手改` : ''}。`;
    }),
    import: importToTavern,
    switchRoute: () => switchRoute(Number($(state.root).find('.cw-route').val())),
    exportDraft: () => download(`写卡工坊_${draft().name || '草稿'}.json`, JSON.stringify(draft(), null, 2)),
    importDraft: () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = async () => {
            try {
                const data = JSON.parse(await input.files[0].text());
                if (!data || typeof data !== 'object' || !('idea' in data)) throw new Error('不是写卡工坊的草稿');
                pushHistory();
                settings().draft = { ...emptyDraft(), ...data };
                saveDraft(); renderAll();
            } catch (e) { toastr.error(String(e.message || e), '写卡工坊'); }
        };
        input.click();
    },
    intro: () => step(() => flow.intro(draft()), '简介写好了，可以换标题。'),
    pickTitle: (el) => { const d = draft(); d.intro.pick = Number(el.dataset.i); d.intro.text = flow.composeIntroFor(d); saveDraft(); renderAll(); },
    copyIntro: async () => {
        try { await navigator.clipboard.writeText(draft().intro.text ?? ''); toastr.success('已复制', '写卡工坊'); } catch { toastr.warning('复制失败，手动全选复制吧', '写卡工坊'); }
    },
    saveIntro: async () => {
        const c = getCtx();
        const d = draft();
        if (!d.imported?.avatar) return toastr.info('先导入酒馆', '写卡工坊');
        const res = await fetch('/api/characters/merge-attributes', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ avatar: d.imported.avatar, data: { creator_notes: d.intro.text } }) });
        if (res.ok) toastr.success('简介已写进角色卡的作者备注', '写卡工坊'); else toastr.error(`写入失败（HTTP ${res.status}）`, '写卡工坊');
    },
};

function bindPopup(root) {
    const $root = $(root);
    $root.on('click', '[data-act]', function (ev) {
        const act = this.dataset.act;
        if (act === 'lockDice') return; // 复选框走 change
        if (this.classList.contains('disabled') && act !== 'stop') return;
        ev.preventDefault();
        ACTIONS[act]?.(this);
    });
    $root.on('change', 'input[data-act="lockDice"]', function () { ACTIONS.lockDice(this); });
    $root.on('input change', '[data-bind]', function () {
        const d = draft();
        setPath(d, this.dataset.bind, this.value);
        if (this.dataset.bind === 'name') d.nameAuto = false;
        if (this.dataset.bind === 'intro.text') $root.find('.cw-len').text(`${[...this.value].length} 字`);
        saveDraft();
    });
    $root.on('input', '[data-bind-list]', function () {
        setPath(draft(), this.dataset.bindList, this.value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean));
        saveDraft();
    });
    const S = () => settings();
    $root.on('input change', '[data-set]', function () {
        let v = this.type === 'checkbox' ? this.checked : this.value;
        if (this.dataset.num !== undefined) v = Number(v) || 0;
        setPath(S(), this.dataset.set, v);
        save();
    });
    $root.on('change', '.cw-step-sel', function () { state.editStep = this.value; renderAll(); });
    $root.on('input', '.cw-step-ta', function () { S().prompts[state.editStep] = this.value.trim() === DEFAULT_PROMPTS[state.editStep].trim() ? '' : this.value; save(); });
    $root.on('change', '.cw-rule-sel', function () { state.editRule = this.value; renderAll(); });
    $root.on('input', '.cw-rule-ta', function () { S().rules[state.editRule] = this.value.trim() === DEFAULT_RULES[state.editRule].trim() ? '' : this.value; save(); });
    $root.on('change', '.cw-dim-sel', function () { state.editDim = this.value; renderAll(); });
    $root.on('input', '.cw-dim-ta', function () { S().customTags[state.editDim] = this.value.split('\n').map((x) => x.trim()).filter(Boolean); save(); });
    $root.on('input change', '[data-step]', function () {
        const st = S().customSteps[Number(this.dataset.step)];
        if (!st) return;
        st[this.dataset.key] = this.dataset.key === 'keys' ? this.value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) : this.value;
        save();
    });
    $root.on('change', '.cw-hist', function () {
        const i = Number(this.value);
        if (this.value === '') return;
        const s = settings();
        const pick = s.drafts[i];
        pushHistory();
        s.drafts = (s.drafts ?? []).filter((x) => x.id !== pick.id);
        s.draft = structuredClone(pick);
        state.checks = null; state.bagu = null;
        saveDraft(); renderAll();
    });
}

async function openWorkshop() {
    const c = getCtx();
    await loadBagu();
    const root = document.createElement('div');
    state.root = root;
    bindPopup(root);
    renderAll();
    await c.callGenericPopup(root, c.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '关闭' });
    state.abort = true;
    state.root = null;
    saveDraft();
}

// ───────────── 扩展设置面板 ─────────────

/** 写卡工坊里的“设置”页：API、预设、写卡、简介 */
function settingsPageHtml() {
    const s = settings();
    const profiles = listProfiles();
    const presets = listPresets();
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const presetSel = (key) => `<select class="text_pole cw-in" data-set="${key}">${opt('', '不用预设', s[key])}${presets.map((p) => opt(p, p, s[key])).join('')}</select>`;
    return `<div class="cw-form">
<div class="cw-sub">API</div>
<label>用哪个 API<select class="text_pole cw-in" data-set="apiProfile">${opt('', '酒馆当前连接的 API', s.apiProfile)}${profiles.map((p) => opt(p.id, `连接配置文件：${p.name}`, s.apiProfile)).join('')}</select></label>
<div class="cw-dim cw-small">默认用酒馆现在连着的 API。想写卡和聊天用不同的模型，先在酒馆的“连接配置文件”里存一个，再在这里选。</div>
<label>两次调用间隔（秒）<input class="text_pole cw-num" type="number" min="0" step="1" data-set="minInterval" data-num value="${s.minInterval}"></label>
<div class="cw-dim cw-small">老是 429 就调大。遇到 429 插件会自动等 15/30/60 秒重试。</div>
<label>最大回复长度<input class="text_pole cw-num" type="number" data-set="maxTokens" data-num value="${s.maxTokens}"></label>
<div class="cw-dim cw-small">0 = 跟酒馆设置。世界观、人设比较长，回复被截断就调大，比如 8000。</div>
<label class="checkbox_label"><input type="checkbox" data-set="useTemperature" ${s.useTemperature ? 'checked' : ''}>用连接配置文件时按步骤调温度（构想高、质检低）</label>

<div class="cw-sub">预设</div>
<label>写卡预设<small class="cw-dim">构想、人设、世界观、质检用</small>${presetSel('presetCard')}</label>
<label>开场白预设<small class="cw-dim">选你平时玩卡用的正文预设</small>${presetSel('presetGreeting')}</label>
<div class="cw-dim cw-small">插件会把这个预设里打开的提示词条目一起发出去（聊天记录、角色描述这类占位条目跳过），不会切换你酒馆当前的预设。列表里是对话补全预设。</div>

<div class="cw-sub">写卡</div>
<label>人设放哪里<select class="text_pole cw-in" data-set="personaPlace">${opt('blue', '世界书 · 蓝灯常驻', s.personaPlace)}${opt('description', '角色卡的角色描述', s.personaPlace)}${opt('green', '世界书 · 绿灯 + 蓝灯概要', s.personaPlace)}</select></label>
<label>玩家写法<input class="text_pole cw-in" data-set="userToken" value="${esc(s.userToken)}"></label>
<label>每条路线开场白<span class="cw-row"><input class="text_pole cw-num" type="number" min="1" max="5" data-set="greetingCount" data-num value="${s.greetingCount}"> 个，每个 <input class="text_pole cw-num" data-set="greetingLength" value="${esc(s.greetingLength)}"> 字</span></label>
<label class="checkbox_label"><input type="checkbox" data-set="autoPredict" ${s.autoPredict ? 'checked' : ''}>一键出卡时做可预测性测试，撞车就自动重写（每个角色多 2–3 次调用）</label>
<label class="checkbox_label"><input type="checkbox" data-set="autoBagu" ${s.autoBagu ? 'checked' : ''}>一键出卡时用八股清理改写</label>

<div class="cw-sub">简介</div>
<label>作者<input class="text_pole cw-in" data-set="author" value="${esc(s.author)}"></label>
<label>二传<input class="text_pole cw-in" data-set="license.repost" value="${esc(s.license.repost)}"></label>
<label>二改<input class="text_pole cw-in" data-set="license.edit" value="${esc(s.license.edit)}"></label>
<label>商用<input class="text_pole cw-in" data-set="license.commercial" value="${esc(s.license.commercial)}"></label>
<label>预设参考<input class="text_pole cw-in" data-set="presetNote" value="${esc(s.presetNote)}" placeholder="空着就写开场白预设的名字"></label>
<label>其他说明<input class="text_pole cw-in" data-set="introNotes" value="${esc(s.introNotes)}"></label>
</div>`;
}

/** 扩展设置面板只放一个入口 */
function settingsHtml() {
    return `
<div class="cw-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>写卡工坊 v${VERSION}</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="menu_button cw-open"><i class="fa-solid fa-feather-pointed"></i> 打开写卡工坊</div>
      <small class="cw-dim">API、预设、提示词都在写卡工坊的目录里：“设置”和“提示词”。</small>
    </div>
  </div>
</div>`;
}

function bindSettings() {
    $('.cw-settings').on('click', '.cw-open', openWorkshop);
}

jQuery(async () => {
    settings();
    $('#extensions_settings2').append(settingsHtml());
    bindSettings();
    const $menu = $('<div id="cw_menu_button" class="list-group-item flex-container flexGap5 interactable" tabindex="0"><div class="fa-solid fa-feather-pointed extensionsMenuExtensionButton"></div>写卡工坊</div>');
    $menu.on('click', openWorkshop);
    $('#extensionsMenu').append($menu);
    loadBagu();
});
