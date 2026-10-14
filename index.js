// 写卡工坊 · SillyTavern 扩展
// 一句话脑洞 → 构想 → 标签 → 人设 → 世界观 → NPC → 路线 → 基调与规则 → 开场白 → 质检 → 导入 → 简介
import { buildLibrary, toggleTag, tagValue, dimOf } from './src/tags.js';
import { DEFAULT_PROMPTS, DEFAULT_RULES, STEP_INFO, TEMPLATE_VARS, RULE_META, CARD_MODES } from './src/prompts.js';
import { unshield, findWords } from './src/parse.js';
import { lifeStoryStats, thinLifeStory } from './src/checks.js';
import { CREDIT_WORKSHOP, emptyDraft, buildEntries, toWorldData, buildCharacter, uniqueName, orderedGreetings, mapStrings, DEFAULT_INTRO_STYLE, INTRO_VARS, mergeWorld, cardUpdate, worldToBook, sentContext } from './src/assemble.js';
import { makeTokenCounter, fmtTokens } from './src/tokens.js';
import { makeFlow } from './src/flow.js';
import { callLLM, listProfiles, listPresets } from './src/llm.js';
import { loadBagu, hasBagu, baguOptions, baguScan, baguRewrite, baguRewriteMany, wordsText, isInstructions } from './src/bagu.js';

const MODULE = 'cardWorkshop';
const VERSION = '0.15.0';
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
    autoBackstory: true,
    backstoryCount: '4–7',
    introStyles: [],
    styles: [],
    customRules: {},
    ruleOff: {},
    ruleModes: {},
    ruleSteps: {},
    offPages: [],
    introStyle: 0,
    minInterval: 3,
    greetingCount: 2,
    greetingLength: '600–900',
    author: '',
    license: { repost: '不可', edit: '可', commercial: '不可' },
    presetNote: '',
    introNotes: '',
    introThanks: '',
    predictThreshold: 0.42,
    autoPredict: true,
    autoBagu: true,
    greetMustClean: true,
    blueBudget: 4000,
    playLength: 300,
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

/** 所有 API 调用都走这里：计数、429/502 等待提示、可以停止 */
function llm(o) {
    state.calls = (state.calls ?? 0) + 1;
    state.stepCalls = (state.stepCalls ?? 0) + 1;
    updateCalls();
    const before = state.lastStatus;
    let waited = false;
    const back = (x) => { if (waited && state.lastStatus !== before) setStatus(before); return x; };
    return callLLM({
        ...o,
        settings: settings(),
        userToken: settings().userToken || '<user>',
        aborted: () => state.abort,
        onWait: (sec, why) => { waited = true; setStatus(`API 返回 ${why || '429（请求太频繁）'}，${sec} 秒后自动重试…`); },
    }).then(back);
}

// ───────────── token ─────────────
const TOK = makeTokenCounter(() => getCtx().getTokenCountAsync, () => refreshTokens());
const tokText = (list, o) => fmtTokens(TOK.sum((list ?? []).map((x) => String(x ?? '')), o));
/** 一段文字的 token 数；后台算完精确值后自动更新（文字不进 HTML 属性） */
const TOKREF = new Map();
let tokSeq = 0;
function tokSpan(list) {
    const k = String(++tokSeq);
    TOKREF.set(k, list);
    return `<span class="cw-tok" data-tok-ref="${k}">${tokText(list)}</span>`;
}

/** 导入后每次聊天都会发的设定（蓝灯 + 当前路线 + 角色描述） */
function blueItems(d = draft()) {
    const c = sentContext(d, { personaPlace: settings().personaPlace, activeRoute: 0 });
    return [...c.before, ...c.card, ...c.after];
}
function blueLine(d = draft()) {
    const items = blueItems(d);
    if (!items.length) return '';
    const t = TOK.sum(items.map((x) => x.text));
    const max = Number(settings().blueBudget) || 0;
    const over = max && t.n > max;
    return `<span class="cw-tok ${over ? 'cw-warntext' : ''}" data-tok-blue>常驻设定 ${fmtTokens(t)}${max ? `（上限 ${max}${over ? '，超了' : ''}）` : ''}</span>`;
}
function blueHtml(d = draft()) {
    const items = blueItems(d);
    if (!items.length) return '';
    const green = sentContext(d, { personaPlace: settings().personaPlace }).green;
    const row = (x) => `<div class="cw-small cw-tokrow"><span class="cw-grow">${esc(x.label)}</span>${tokSpan([x.text])}</div>`;
    return `<div class="cw-box"><div class="cw-sub">token ${blueLine(d)}</div>
<div class="cw-dim cw-small">每次聊天都会发出去的：蓝灯条目、第一条路线、角色描述。上限在设置里改，0 = 不提示。</div>
<details class="cw-mini"><summary>每一块多少</summary>${[...items].sort((a, b) => TOK.count(b.text).n - TOK.count(a.text).n).map(row).join('')}
${green.length ? `<div class="cw-sub cw-small">绿灯（提到关键词才发）</div>${green.map(row).join('')}` : ''}</details></div>`;
}

/** 后台算完精确 token 数后，更新页面上的数字（不重画整页，避免打断输入） */
function refreshTokens() {
    if (!state.root) return;
    const $r = $(state.root);
    const d = draft();
    $r.find('.cw-tok[data-tok-path]').each(function () { this.textContent = tokText([getPath(d, this.dataset.tokPath)]); });
    $r.find('.cw-tok[data-tok-blue]').each(function () { const h = blueLine(d); if (h) this.outerHTML = h; });
    $r.find('.cw-tok[data-tok-ref]').each(function () { const l = TOKREF.get(this.dataset.tokRef); if (l) this.textContent = tokText(l); });
    $r.find('.cw-tok[data-tok-page]').each(function () { this.textContent = `这一页 ${tokText(pageSlots(this.dataset.tokPage).map((x) => x.get()))}`; });
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

/** 按钮。extra 里可以带 class="…"，会并进按钮自己的 class（重复的 class 属性浏览器会忽略） */
const btn = (act, label, extra = '') => {
    let cls = '';
    const rest = String(extra).replace(/\bclass="([^"]*)"/, (_, c) => { cls = ` ${c}`; return ''; });
    return `<div class="menu_button cw-btn${cls}" data-act="${act}" ${rest}>${label}</div>`;
};
const ta = (path, rows = 6, ph = '') => `<textarea class="text_pole cw-ta" data-bind="${path}" rows="${rows}" placeholder="${esc(ph)}">${esc(getPath(draft(), path) ?? '')}</textarea>${rows >= 5 ? `<div class="cw-tokline"><span class="cw-tok" data-tok-path="${path}">${tokText([getPath(draft(), path)])}</span></div>` : ''}`;
const inp = (path, ph = '', cls = '') => `<input class="text_pole cw-in ${cls}" data-bind="${path}" value="${esc(getPath(draft(), path) ?? '')}" placeholder="${esc(ph)}">`;
const listInp = (path, ph = '关键词，逗号分隔') => `<input class="text_pole cw-in" data-bind-list="${path}" value="${esc((getPath(draft(), path) ?? []).join('，'))}" placeholder="${esc(ph)}">`;

/** 文本框路径 → 这一块的“换回上一版”键和名字 */
function keyOfPath(d, path) {
    const m = path.split('.');
    const at = (i) => getPath(d, m.slice(0, i).join('.'));
    switch (m[0]) {
        case 'personas': { const p = at(2); return p ? { key: `persona:${p.name}`, label: `${m[2] === 'overview' ? '人设概要' : '人设'}·${p.name}` } : null; }
        case 'world': return { key: 'world', label: '世界观' };
        case 'npcs': return { key: 'npc', label: `NPC·${at(2)?.name ?? ''}` };
        case 'routes': return { key: 'routes', label: `路线·${at(2)?.name ?? ''}` };
        case 'tone': return { key: 'tone', label: '基调与规则' };
        case 'relations': return { key: 'relations', label: '角色关系' };
        case 'free': return { key: `free:${String(at(2)?.name ?? '').trim()}`, label: `模块·${at(2)?.name ?? ''}` };
        case 'greetings': return { key: `greet:${at(2)?.route ?? ''}`, label: '开场白' };
        case 'intro': return m[1] === 'text' ? { key: 'intro', label: '简介' } : null;
        case 'au': return m[1] === 'map' ? { key: 'au:map', label: 'AU 映射表' } : { key: 'au:core', label: 'AU 内核' };
        case 'existing':
            if (m[1] === 'fields') return { key: `exist:field:${m[2]}`, label: { description: '角色描述', personality: '性格', scenario: '场景', mes_example: '对话示例' }[m[2]] ?? m[2] };
            if (m[1] === 'entries') return { key: `exist:entry:${at(3)?.uid}`, label: at(3)?.comment ?? '条目' };
            if (m[1] === 'greetings') return { key: `exist:greet:${m[2]}`, label: `原卡开场白 ${Number(m[2]) + 1}` };
            return null;
        default: return null;
    }
}

/** 在文本框里选中一段后，框下面出现“局部重写” */
const LOCAL_SKIP = /^(idea|feedback|play|ideaQA|inspire|qa)\b/;
function updateSelBar(el) {
    const path = el.dataset.bind;
    const $el = $(el);
    const $wrap = $el.next('.cw-tokline').length ? $el.next('.cw-tokline') : $el;
    let $bar = $wrap.next('.cw-selbar');
    const a = el.selectionStart, b = el.selectionEnd;
    if (!path || LOCAL_SKIP.test(path) || !(b > a) || !el.value.slice(a, b).trim()) { if (!$bar.find('.cw-selin').is(':focus')) $bar.remove(); return; }
    state.sel = { path, start: a, end: b };
    const n = [...el.value.slice(a, b)].length;
    if (!$bar.length) {
        $bar = $(`<div class="cw-selbar"><div class="cw-row"><span class="cw-small cw-selcount"></span><span class="cw-grow"></span>${btn('localEdit', '局部重写', 'class="cw-primary"')}</div><input class="text_pole cw-in cw-selin" placeholder="怎么改？比如“更狠一点”“改成他嘴硬”。空着就是重写这一段"></div>`);
        $bar.find('.cw-selin').val(state.selNote ?? '');
        $wrap.after($bar);
    }
    $bar.find('.cw-selcount').text(`已选 ${n} 字，只改这一段`);
}

/** 每一块下面：修改意见、换回上一版、截断提醒 */
function toolsHtml(key, hasContent = true) {
    const d = draft();
    const n = d.history?.[key]?.length ?? 0;
    const cut = d.truncated?.[key];
    if (!hasContent && !n) return '';
    return `<div class="cw-tools">
${cut ? `<div class="cw-warn">回复可能被截断了（自动续写过一次还不完整）。在“设置”里把最大回复长度调大再重写，或者手动补完。</div>` : ''}
<input class="text_pole cw-in cw-fb" data-bind="feedback.${esc(key)}" value="${esc(d.feedback?.[key] ?? '')}" placeholder="哪里不满意？写在这里，点重写时会带上（可选）">
${(hasContent && flow.textSlot(d, key)) || n ? `<div class="cw-row">${hasContent && flow.textSlot(d, key) ? btn('revise', '按意见改', `data-key="${esc(key)}"`) : ''}${n ? btn('restore', `换回上一版（存了 ${n} 版）`, `data-key="${esc(key)}"`) : ''}</div>` : ''}
${changesHtml(d.changes?.[key])}
</div>`;
}

/** 人设页顶部：这张卡用哪个文风 */
function styleRowHtml() {
    const d = draft();
    const list = settings().styles ?? [];
    return `<div class="cw-row"><span class="cw-small">文风</span><select class="text_pole cw-in cw-stylesel" style="width:auto"><option value="0">不指定</option>${list.map((x, i) => `<option value="${i + 1}" ${Number(d.style) === i + 1 ? 'selected' : ''}>${esc(x.name || `文风 ${i + 1}`)}</option>`).join('')}</select>
${Number(d.style) ? `<label class="checkbox_label cw-small"><input type="checkbox" class="cw-styleall" ${d.styleAll ? 'checked' : ''}>世界观、NPC、路线、模块、开场白也用</label>` : ''}<span class="cw-grow"></span><span class="menu_button cw-btn" data-act="go" data-page="prompts" data-tab="style">${list.length ? '编辑文风' : '写一个文风'}</span></div>`;
}

/** 上次改了哪里：原来 → 现在 */
function changesHtml(c) {
    if (!c) return '';
    if (!c.hunks?.length) return `<div class="cw-small cw-dim">${esc(c.how || '上次修改')}：没有改动。</div>`;
    const cut = (t) => (t.length > 400 ? `${t.slice(0, 400)}……` : t);
    return `<details class="cw-mini cw-changes" open><summary>${esc(c.how || '上次修改')}：改了 ${c.hunks.length + (c.more ?? 0)} 处</summary>
${c.hunks.map((h) => `<div class="cw-hunk">${h.before.trim() ? `<div class="cw-del">${esc(cut(h.before.trim())).replace(/\n/g, '<br>')}</div>` : '<div class="cw-dim cw-small">（新加）</div>'}${h.after.trim() ? `<div class="cw-add">${esc(cut(h.after.trim())).replace(/\n/g, '<br>')}</div>` : '<div class="cw-dim cw-small">（删掉了）</div>'}</div>`).join('')}
${c.more ? `<div class="cw-dim cw-small">还有 ${c.more} 处没列出来。</div>` : ''}
<div class="cw-dim cw-small">红色是原来的，绿色是现在的。不满意点“换回上一版”。</div></details>`;
}

/** AU：内核、AU 设定、映射表 */
function auHtml() {
    const d = draft();
    const au = d.au;
    if (!au) return '<div class="cw-dim">不是 AU 草稿。</div>';
    const hasCore = au.core.some((c) => c.text.trim());
    return `<div class="cw-small">原卡：<b>${esc(au.original.name)}</b>。人还是那个人，换世界观和身份。原卡不会被改动，最后存成一张新卡。</div>
<div class="cw-card"><div class="cw-sub">① 内核 <small class="cw-dim">换到哪个世界都不变的东西，之后锁定</small></div>
<div class="cw-row">${btn('auCore', hasCore ? '重新提取' : '从原卡提取内核')}</div>
${toolsHtml('au:core', hasCore)}
${au.core.map((c, i) => `<div class="cw-sub">${esc(c.name)}</div>${ta(`au.core.${i}.text`, 8, '矛盾轴与落点、对 user 的底色、说话方式、决策方式、底线')}`).join('')}
<details class="cw-mini" ${au.shell ? '' : 'open'}><summary>外壳 <small class="cw-dim">原作世界的东西，AU 里要换掉</small></summary>${ta('au.shell', 5, '身份、职业、时代、组织、地点、道具、关键经历……')}</details></div>
<div class="cw-card"><div class="cw-sub">② AU 设定</div>
${ta('idea', 3, '一句话 AU：比如“现代都市，他是外卖骑手，<user>是新来的站长”')}
<div class="cw-row">${btn('ideaQA', d.ideaQA?.length ? '换几个问题' : '先问我几个问题')}${btn('go', '去改标签', 'data-page="tags"')}</div>
${d.ideaQA?.length ? d.ideaQA.map((q, i) => `<div class="cw-q"><div class="cw-qt">${esc(q.q)}</div>${answerHtml(`ideaQA.${i}.answer`, q.options)}</div>`).join('') : ''}
<div class="cw-dim cw-small">原作的题材、原型标签没带过来，按 AU 重新选。</div></div>
<div class="cw-card"><div class="cw-sub">③ 映射表 <small class="cw-dim">原作 → AU，每条写清为什么还能长出同样的内核</small></div>
<div class="cw-row">${hasCore && d.idea.trim() ? `<div class="menu_button cw-btn ${au.map ? '' : 'cw-primary'}" data-act="auMap">${au.map ? '重写映射表' : '生成映射表 →'}</div>` : '<span class="cw-dim cw-small">先提取内核、写好 AU 设定</span>'}</div>
${toolsHtml('au:map', !!au.map)}
${ta('au.map', 10, '原：扒手团 → AU：城中村的外卖站｜……')}</div>
<details class="cw-mini"><summary>原卡内容（只读）</summary><textarea class="text_pole cw-ta" rows="10" readonly>${esc(au.original.personas.map((p) => `【${p.name}】\n${p.text}`).join('\n\n'))}</textarea></details>
<div class="cw-dim cw-small">映射表写好后，去“主要人设”生成 AU 人设，生成完点“内核一致性检查”。后面的世界观、NPC、路线、开场白照常写，都会带上内核和映射表。</div>`;
}

/** 选一张酒馆里的卡读进来 */
function loadHtml() {
    const c = getCtx();
    const list = (c.characters ?? []).filter((x) => x?.avatar && x?.name);
    const cur = draft().existing?.avatar ?? c.characters?.[c.characterId]?.avatar;
    if (!list.length) return '<div class="cw-dim">酒馆里还没有角色卡。</div>';
    return `<div class="cw-small">选一张酒馆里的角色卡读进来。人设、世界书条目、开场白都能改，也能加路线、加开场白，改完在“导入酒馆”页写回原卡（会先备份，可以撤销）。</div>
<input class="text_pole cw-in cw-cardfilter" placeholder="筛选卡名">
<select class="text_pole cw-in cw-cardsel" size="8">${list.map((x) => `<option value="${esc(x.avatar)}" ${x.avatar === cur ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
<div class="cw-row"><div class="menu_button cw-btn cw-primary" data-act="loadCard">读取这张卡，改原卡 →</div><div class="menu_button cw-btn" data-act="loadAU">用这张卡做 AU（存成新卡）</div></div>
<div class="cw-dim cw-small">现在的草稿会放进“历史草稿”，随时能读回来。写卡工坊做的卡能认回各个步骤；别人做的卡，世界书条目会原样放在“原卡内容”里。</div>`;
}

/** 原卡内容：描述、世界书里的其他条目、原来的开场白 */
function existingHtml() {
    const d = draft();
    const ex = d.existing;
    if (!ex) return '<div class="cw-dim">还没读卡。</div>';
    const fromDesc = d.personas.some((p) => p.fromDescription);
    const field = (k, label, always = false) => (!always && !String(ex.fields[k] ?? '').trim() ? '' : `<div class="cw-card"><div class="cw-sub">${label}</div>${ta(`existing.fields.${k}`, 5)}${toolsHtml(`exist:field:${k}`, !!String(ex.fields[k] ?? '').trim())}</div>`);
    return `<div class="cw-small">原卡：<b>${esc(ex.name)}</b> · ${ex.world ? `世界书 ${esc(ex.world)}` : '没绑世界书（写回时会新建一本并绑定）'}</div>
<div class="cw-dim cw-small">直接改字，或者在“哪里不满意”里写意见再点“按意见改”。写卡工坊认得的条目（人设、世界观、NPC、路线、基调、模块）在对应的页里改。</div>
${fromDesc ? '<div class="cw-box cw-small">这张卡的角色描述就是人设，在“主要人设”页里改。</div>' : field('description', '角色描述', true)}
${field('personality', '性格')}${field('scenario', '场景')}${field('mes_example', '对话示例')}
<div class="cw-sub">世界书里的其他条目（${ex.entries.length}）</div>
${ex.entries.map((e, i) => `<div class="cw-card"><div class="cw-row"><b class="cw-grow">${esc(e.comment)}</b><label class="cw-small"><input type="checkbox" class="cw-exen" data-i="${i}" ${e.disable ? '' : 'checked'}> 启用</label></div>
<div class="cw-dim cw-small">${e.constant ? '蓝灯' : `绿灯 · ${esc((e.key ?? []).join('、') || '没有关键词')}`}</div>
${ta(`existing.entries.${i}.content`, 6)}${toolsHtml(`exist:entry:${e.uid}`, !!e.content.trim())}</div>`).join('') || '<div class="cw-dim cw-small">没有。</div>'}
<div class="cw-sub">原来的开场白（${ex.greetings.length}）</div>
${ex.greetings.map((g, i) => `<div class="cw-card"><div class="cw-row"><b class="cw-grow">${i === 0 ? '主开场白' : `额外开场白 ${i}`}</b>${btn('del', '删', `data-path="existing.greetings" data-i="${i}"`)}</div>${ta(`existing.greetings.${i}`, 8)}${toolsHtml(`exist:greet:${i}`, !!g.trim())}</div>`).join('')}
<div class="cw-dim cw-small">新的开场白在“开场白”页写，写回时加在原来的后面。</div>`;
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

const ABOUT_LICENSE = [
    '使用：免费。',
    '二传：请保留作者（酒疫）和原仓库链接 https://github.com/jiuyi777/card-workshop。',
    '二改：可以，请注明改自写卡工坊；默认提示词和人设模板来自灰鸠老师，二改时也请保留这条致谢。',
    '商用：不可以。',
    '用写卡工坊写出来的卡归卡作者自己。',
];

const OPTIONAL_PAGES = ['world', 'npc', 'routes', 'tone', 'play', 'check', 'intro'];

const PAGES = [
    { id: 'idea', name: '一句话构想', desc: '一句话脑洞，或者掷骰子', status: (d) => (d.pick >= 0 && d.concepts[d.pick] ? d.concepts[d.pick].title : d.concepts.length ? `${d.concepts.length} 个构想，还没选` : ''), done: (d) => !!d.existing || !!d.au?.map || (d.pick >= 0 && !!d.concepts[d.pick]) },
    { id: 'tags', name: '标签', desc: '构想时自动勾好，可以再改', status: (d) => d.tags.map((t) => t.name).slice(0, 6).join('、'), done: (d) => d.tags.length > 0 || !!d.existing },
    { id: 'persona', name: '主要人设', desc: '先答问题，再生成', status: (d) => (flow.modeOf(d) === 'world' && !d.personas.length ? '世界卡，人物在 NPC 里' : d.personas.map((p) => `${p.name}${p.text ? ' ✓' : ''}`).join('、') + (flow.modeOf(d) === 'multi' && d.personas.length > 1 ? (d.relations ? ' · 关系网 ✓' : ' · 关系网没写') : '')), done: (d) => (flow.modeOf(d) === 'world' && !d.personas.length) || (d.personas.length > 0 && d.personas.every((p) => p.text) && (flow.modeOf(d) !== 'multi' || d.personas.length < 2 || !!d.relations)) },
    { id: 'world', name: '世界观', status: (d) => (d.world.main ? '已写' : ''), done: (d) => !!d.world.main },
    { id: 'npc', name: 'NPC', status: (d) => (d.npcs.length ? `${d.npcs.length} 个` : ''), done: (d) => d.npcs.length > 0 || d.concepts[d.pick]?.npcs === 0 },
    { id: 'routes', name: '玩家与路线', status: (d) => (d.routes.length ? `${d.routes.filter((r) => r.info).length}/${d.routes.length} 条已写` : ''), done: (d) => d.routes.length > 0 && d.routes.every((r) => r.info) },
    { id: 'tone', name: '基调与规则', desc: '还有自由模块', status: (d) => (d.tone ? '已写' : ''), done: (d) => !!d.tone },
    { id: 'greet', name: '开场白', status: (d) => (d.greetings.length ? `${d.greetings.length} 个` : ''), done: (d) => d.greetings.length > 0 },
    { id: 'play', name: '试玩', desc: '跑几轮看好不好玩，再让 AI 点评', status: (d) => (d.play?.review ? `点评 ${d.play.review.score ?? ''} 分` : d.play?.messages?.length > 1 ? `${d.play.messages.length} 条` : ''), done: (d) => !!d.play?.review },
    { id: 'check', name: '质检', desc: '本地扫描 · 八股清理', status: () => (state.checks ? '扫描过' : ''), done: () => !!state.checks },
    { id: 'import', name: '导入酒馆', status: (d) => (d.imported ? `已导入：${d.imported.name}` : ''), done: (d) => !!d.imported },
    { id: 'intro', name: '简介', desc: 'Discord 简介和标题', status: (d) => (d.intro?.text ? '已写' : ''), done: (d) => !!d.intro?.text },
];

/** 自定义步骤按“放在哪一步后面”插进目录 */
function pages() {
    const d = draft();
    const steps = settings().customSteps ?? [];
    const out = [];
    if (d.au) {
        const au = d.au;
        out.push({ id: 'au', name: 'AU 内核与映射', desc: '提取内核 → 写 AU 设定 → 映射表', status: () => (au.map ? '映射表已写' : au.core.some((c) => c.text) ? '内核已提取' : ''), done: () => !!au.map && au.core.every((c) => c.text) });
    }
    if (d.existing) {
        const ex = d.existing;
        out.push({ id: 'existing', name: '原卡内容', desc: '原来的描述、世界书条目、开场白', status: () => `${ex.entries.length} 个条目 · ${ex.greetings.length} 个开场白`, done: () => true });
    }
    const mine = (st) => {
        const f = d.free.find((x) => x.fromStep === st.id);
        return { id: `step:${st.id}`, name: st.name || '我的步骤', desc: '我的步骤', custom: st, status: () => (f?.content ? '已写' : ''), done: () => !!f?.content };
    };
    const off = new Set(settings().offPages ?? []);
    for (const p of PAGES) {
        if (p.id === 'idea' && d.au) continue; // AU 设定在“AU 内核与映射”页里写
        if (!off.has(p.id)) out.push(p);
        for (const st of steps) if ((st.after || 'tone') === p.id) out.push(mine(st));
    }
    return out;
}

const nextPage = (d) => pages().find((p) => !p.done(d)) ?? null;

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
    const dname = (x) => x.name || x.idea?.slice(0, 16) || '未命名';
    const when = (t) => (t ? new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
    const hist = (s.drafts ?? []).map((x, i) => `<div class="cw-row cw-draftrow"><span class="cw-grow cw-small"><b>${esc(dname(x))}</b> <span class="cw-dim">${esc(when(x.updated))}${x.existing ? ' · 改已有的卡' : x.au ? ' · AU' : ''}</span></span>${btn('openDraft', '打开', `data-i="${i}"`)}${btn('delDraft', '删除', `data-i="${i}"`)}</div>`).join('');
    const n = nextPage(d);
    const tile = (p, i) => {
        const st = p.status?.(d) || '';
        return `<div class="cw-tile ${p.done(d) ? 'done' : ''} ${n?.id === p.id ? 'next' : ''}" data-act="go" data-page="${p.id}">
<div class="cw-tn">${i + 1}. ${esc(p.name)}${p.done(d) ? ' <span class="cw-ok">✓</span>' : ''}</div>
<div class="cw-ts">${esc(st || p.desc || '还没开始')}</div></div>`;
    };
    return `${topHtml(`<div class="cw-row"><input class="text_pole cw-in cw-grow" data-bind="name" value="${esc(d.name)}" placeholder="卡名（导入时用）">${btn('newDraft', '新建')}<div class="menu_button cw-btn" data-act="go" data-page="load">改已有的卡</div></div>
<details class="cw-mini cw-drafts"><summary>草稿（当前 1 份${s.drafts?.length ? `，历史 ${s.drafts.length} 份` : ''}）</summary>
<div class="cw-row cw-draftrow"><span class="cw-grow cw-small"><b>当前：${esc(dname(d))}</b> <span class="cw-dim">${esc(when(d.updated))}</span></span>${btn('delCurrent', '删除当前草稿')}</div>
${hist || '<div class="cw-dim cw-small">没有历史草稿。点“新建”时当前草稿会放进这里（最多 8 份）。</div>'}
${s.drafts?.length ? `<div class="cw-row cw-end">${btn('clearDrafts', '清空历史草稿')}</div>` : ''}
</details>`)}
${d.au ? `<div class="cw-box cw-small">正在做 AU：<b>${esc(d.au.original.name)}</b> → ${esc(d.name)}。原卡不会动，最后存成一张新卡。</div>` : ''}
${d.existing ? `<div class="cw-box cw-small">正在改已有的卡：<b>${esc(d.existing.name)}</b>（${d.existing.world ? `世界书 ${esc(d.existing.world)}` : '没绑世界书'}）。改完到“导入酒馆”页写回原卡。</div>` : ''}
<div class="cw-next">
  ${n ? `<div class="cw-dim cw-small">下一步</div><div class="menu_button cw-btn cw-primary" data-act="go" data-page="${n.id}">${esc(n.name)} →</div>` : '<div>全部完成了。</div>'}
  <div class="cw-row">${btn('auto', d.existing ? '一键补全' : d.au ? '一键出 AU 卡' : '一键出卡')}<span class="cw-dim cw-small cw-grow">${d.existing ? '给还没写的路线写玩家信息，给还没有开场白的路线写开场白；原来的内容不动' : d.au ? '写好 AU 设定后点：提取内核、映射表、AU 人设、一致性检查、世界观、路线、开场白一路跑完' : '写好一句话后点，自动跑完剩下的步骤；已经写好的不会重写'}</span></div>
</div>
${blueLine(d) ? `<div class="cw-small cw-row"><span class="cw-grow">${blueLine(d)}</span><span class="cw-dim">导入后每次聊天都会发的设定</span></div>` : ''}
<div class="cw-grid">${pages().map(tile).join('')}
<div class="cw-tile cw-tool" data-act="go" data-page="settings"><div class="cw-tn">设置</div><div class="cw-ts">用哪个 API、写卡预设、开场白预设、调用间隔、人设放哪里</div></div>
<div class="cw-tile cw-tool" data-act="go" data-page="about"><div class="cw-tn">关于</div><div class="cw-ts">功能、作者与致谢、使用授权、插件会动哪些东西</div></div>
<div class="cw-tile cw-tool" data-act="go" data-page="prompts"><div class="cw-tn">提示词</div><div class="cw-ts">每一步的提示词、规则库（禁用词、直接删的词）、我的标签、我的步骤</div></div>
</div>
${creditsHtml()}`;
}

function pageHtml(id) {
    const list = pages();
    let i = list.findIndex((p) => p.id === id);
    if (i < 0 && id.startsWith('step:')) { state.page = id = 'home'; return homeHtml(); }
    const page = list[i];
    const title = page ? `${i + 1}. ${page.name}` : { settings: '设置', prompts: '提示词', load: '改已有的卡', about: '关于写卡工坊' }[id] ?? '';
    const body = page?.custom ? customHtml(page.custom) : { load: loadHtml, existing: existingHtml, au: auHtml, idea: ideaHtml, tags: tagsHtml, persona: personaHtml, world: worldHtml, npc: npcHtml, routes: routesHtml, tone: toneHtml, greet: greetingHtml, play: playHtml, check: checkHtml, import: importHtml, intro: introHtml, prompts: promptsHtml, settings: settingsPageHtml, about: aboutHtml }[id]();
    const prev = list[i - 1];
    const next = list[i + 1];
    return `${topHtml(`<div class="cw-row"><div class="menu_button cw-btn" data-act="go" data-page="home">← 目录</div><b class="cw-grow cw-ptitle">${esc(title)}</b></div>`)}
<div class="cw-page">${body}${pageBaguHtml(id)}</div>
<div class="cw-foot">${prev ? `<div class="menu_button cw-btn" data-act="go" data-page="${prev.id}">← ${esc(prev.name)}</div>` : ''}<span class="cw-grow"></span>${next ? `<div class="menu_button cw-btn cw-primary" data-act="go" data-page="${next.id}">下一步：${esc(next.name)} →</div>` : `<div class="menu_button cw-btn" data-act="go" data-page="home">回目录</div>`}</div>`;
}

function ideaHtml() {
    const d = draft();
    let html = `${ta('idea', 3, '一句话脑洞，比如：“最后抱我一次吧，在春天结束之前。”……可春天已在你眼前离去了。')}
<div class="cw-row">${btn('ideaQA', d.ideaQA?.length ? '换几个问题' : '先问我几个问题')}${btn('idea', d.concepts.length ? '重新生成构想' : '直接生成构想')}${btn('inspire', '没想法？掷骰子')}</div>
${toolsHtml('idea', d.concepts.length > 0)}`;
    if (d.ideaQA?.length) {
        html += `<div class="cw-box"><div class="cw-sub">关于你的脑洞 <small class="cw-dim">点选或自己写，不想答的留空</small></div>
${d.ideaQA.map((q, i) => `<div class="cw-q"><div class="cw-qt">${esc(q.q)}</div>${answerHtml(`ideaQA.${i}.answer`, q.options)}</div>`).join('')}
<div class="cw-row"><div class="menu_button cw-btn cw-primary" data-act="idea">带上回答生成构想 →</div></div></div>`;
    }
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

/** 目录底部的小字（纯文字，不放链接，免得误触；链接在“关于”页） */
function creditsHtml() {
    return '<div class="cw-credits cw-credline cw-small cw-dim">本写卡工坊默认提示词来自灰鸠老师，请关注灰鸠老师喵。</div>';
}

const HUIJIU_URL = 'https://discord.com/channels/1134557553011998840/1522409047696085143';

/** 关于：功能、作者、授权、插件会动哪些东西 */
function aboutHtml() {
    const tpl = flow.ruleList().find((r) => r.name === '人设模板');
    const tplOn = tpl && tpl.on && !tpl.edited;
    return `<div class="cw-card"><div class="cw-ctitle">写卡工坊 v${VERSION}</div>
<div>在酒馆里写角色卡：一句话脑洞 → 构想 → 人设 → 世界观 → NPC → 路线 → 开场白 → 试玩 → 质检 → 导入 → 简介。目标是写得快、写得好、没灵感时帮你想，并且少八股。</div></div>

<div class="cw-card"><div class="cw-sub">作者与致谢</div>
<div>写卡工坊 · <b>酒疫</b> 老师</div>
<div>默认提示词、人设模板 · <b>灰鸠</b> 老师 <a href="${HUIJIU_URL}" target="_blank" rel="noopener">Discord</a></div>
<div>联动：<b>八股清理</b>（装在同一个扩展目录就会自动接上）</div>
<div class="cw-dim cw-small">生成简介时会自动写致谢：“感谢酒疫老师的写卡工坊”一定写；人设模板没改过时还写“感谢灰鸠老师的人设模板”${tplOn ? '' : '（你改了人设模板，现在不写这条）'}。设置里可以加自己的致谢。</div></div>

<div class="cw-card"><div class="cw-sub">主要功能</div>
<ul class="cw-small">
<li>标签库 + 一句话自动打标签，掷骰子找灵感，问答帮你想清楚角色</li>
<li>单人卡 / 多人卡（角色关系网）/ 无固定角色的世界卡</li>
<li>矛盾建模人设、经历展开、可预测性测试（撞刻板印象就重写）</li>
<li>开场白先想梗再扩写，写完立刻改掉必改词</li>
<li>每页八股检查、按意见改、局部重写、改了什么、换回上一版</li>
<li>试玩几轮再让 AI 点评，问题指到对应页面</li>
<li>token 统计、常驻设定上限提醒</li>
<li>改已有的卡、加路线和开场白、写回原卡（可撤销）、做 AU</li>
<li>规则库可插拔：开关、限定卡类型、插到任意步骤、自己加；文风库；自己加步骤</li>
<li>Discord 简介，多种简介风格</li>
</ul></div>

<div class="cw-card"><div class="cw-sub">使用授权</div>
<div class="cw-small">${ABOUT_LICENSE.map((x) => `<div>${esc(x)}</div>`).join('')}</div></div>

<div class="cw-card"><div class="cw-sub">插件会动哪些东西</div>
<ul class="cw-small">
<li>调 API：用你在设置里选的连接（默认是酒馆当前连接），会带上你绑定的写卡预设 / 开场白预设里打开的条目。不会切换你酒馆当前的预设和连接。</li>
<li>读：角色卡、世界书（改已有的卡、读卡时）；八股清理的设置和“我的八股词”。</li>
<li>写：只在你点“导入酒馆”“写回原卡”“写进角色卡”时创建或修改角色卡和世界书；写回前会备份，可以撤销。不删条目。</li>
<li>草稿、提示词、规则都存在酒馆的扩展设置里，不会发到别的地方。</li>
</ul></div>`;
}

/** 卡的类型：单人 / 多人 / 无固定角色。决定插进哪些规则模块、人设页和 NPC 页怎么写 */
function modeHtml() {
    const d = draft();
    const auto = flow.modeOf({ ...d, mode: '' });
    const cur = flow.modeOf(d);
    const tip = {
        single: '一个主要角色。',
        multi: '几个主要角色地位相当。每个人的人设都会知道其他人；人设页多一块“角色关系网”（关系、修罗场、出场规则），常驻在人设后面；开场白和试玩会让至少两个人有戏份。',
        world: '没有固定角色，AI 扮演整个世界。人设页可以空着；人物写进 NPC 库（默认 6 个起）；基调里会加叙事和 NPC 现编规则；开场白用旁白视角。',
    }[cur];
    return `<div class="cw-box"><div class="cw-row"><span class="cw-sub">卡的类型</span><select class="text_pole cw-in" data-bind="mode" style="width:auto"><option value="" ${d.mode ? '' : 'selected'}>自动（现在是：${esc(CARD_MODES[auto])}）</option>${Object.entries(CARD_MODES).map(([k, v]) => `<option value="${k}" ${d.mode === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
<div class="cw-dim cw-small">${esc(tip)}自动判断看“卡类型”“人数”标签和主要角色有几个。对应的写法在 提示词 → 规则库 的“多人卡”“世界卡”里，可以改，也可以关掉。</div></div>`;
}

function tagsHtml() {
    const d = draft();
    const L = lib();
    const src = d.tagSrc ?? {};
    const chip = (t, on) => `<span class="cw-chip tag ${on ? 'on' : ''} src-${src[`${t.dim}:${t.name}`] ?? 'user'}" data-act="tag" data-dim="${t.dim}" data-name="${esc(t.name)}">${esc(t.name)}${src[`${t.dim}:${t.name}`] === 'guess' ? '?' : ''}</span>`;
    let html = `${modeHtml()}<div class="cw-dim cw-small">上面是已选的标签，点一下取消；下面按维度展开，点一下选上。实线框是你那句话里识别到的，虚线框是 AI 推荐的，带问号的是 AI 猜的，确认一下。</div>`;
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

/** 经历写了多少，太少就提示展开 */
function storyHtml(p, i) {
    if (!p.text?.trim()) return '';
    const st = lifeStoryStats(p.text);
    const thin = thinLifeStory(p.text);
    return `<div class="cw-row cw-small">${btn('backstory', st.found ? '重写经历' : '展开经历', `data-i="${i}"${thin ? ' class="cw-primary"' : ''}`)}<span class="cw-grow ${thin ? 'cw-warntext' : 'cw-dim'}">${st.found ? `经历 ${st.count} 段 · ${st.chars} 字${thin ? '，太少了' : ''}` : '还没写经历'}</span></div>
<div class="cw-dim cw-small">单独调一次 API 只写经历：每段写清发生了什么 → 留下了什么 → 现在怎么冒出来，写完换进人设的 life_story。可以在上面“哪里不满意”里写要求。</div>`;
}

/** AU：内核一致性检查的结果 */
function auCheckHtml(p, i) {
    const d = draft();
    if (!p.text?.trim()) return '';
    const c = d.au.checks?.[p.name];
    const bad = (c?.items ?? []).filter((x) => x.verdict !== '保留');
    return `<div class="cw-box cw-small"><div class="cw-row">${btn('auCheck', c ? '再检查一次' : '内核一致性检查', `data-i="${i}"`)}${c && (bad.length || c.leftovers.length) && !c.fixed ? btn('auFix', `按检查结果修（${bad.length + (c.leftovers.length ? 1 : 0)} 处）`, `data-i="${i}" class="cw-primary"`) : ''}</div>
${c ? `${c.items.map((x) => `<div class="cw-ov"><span class="cw-verdict v-${x.verdict}">${esc(x.verdict)}</span> ${esc(x.core)}${x.verdict !== '保留' ? `<div class="cw-dim">${x.where ? `「${esc(x.where)}」 ` : ''}${esc(x.fix)}</div>` : ''}</div>`).join('')}
${c.leftovers.length ? `<div class="cw-ov"><span class="cw-verdict v-丢了">残留</span> 原作的东西：${esc(c.leftovers.join('、'))}</div>` : ''}
${c.fixed ? '<span class="cw-badge ok">已按检查结果修过，可以再检查一次</span>' : ''}` : '<div class="cw-dim">对照内核逐条检查 AU 人设，看有没有被 AU 题材的套路冲掉、有没有原作残留。</div>'}</div>`;
}

/** 人设里的禁用词和八股，生成完就能看到 */
/** 这一页能做八股检查的文字：规则清单、提示词式的内容不查 */
const BAGU_PAGES = new Set(['au', 'existing', 'persona', 'world', 'npc', 'routes', 'tone', 'greet', 'intro', 'play']);
function pageSlots(id) {
    return flow.textSlots(draft(), { all: true }).filter((s) => s.page === id && !s.rules && !isInstructions(s.get()));
}
/** 本地扫一遍（不调 API）：禁用词 + 八股清理的规则 */
function scanPage(id) {
    const banned = flow.banned(draft());
    const opts = hasBagu() ? baguOptions(getCtx().extensionSettings, banned) : null;
    return pageSlots(id).map((s) => {
        const words = findWords(s.get(), banned);
        const r = opts ? baguScan(s.get(), opts) : null;
        return { s, words, total: r?.total ?? 0, must: r?.must ?? 0, found: r?.words ?? [] };
    });
}
function pageBaguHtml(id) {
    if (!(BAGU_PAGES.has(id) || id.startsWith('step:'))) return '';
    const rows = scanPage(id);
    if (!rows.length) return '';
    const hit = rows.filter((x) => x.words.length || x.total);
    const words = hit.reduce((n, x) => n + x.words.length, 0);
    const total = hit.reduce((n, x) => n + x.total, 0);
    const last = state.baguPage?.page === id ? state.baguPage.report : null;
    const head = hit.length
        ? `八股检查：${[words ? `禁用词 <b class="cw-err">${words}</b> 个` : '', total ? `八股 <b>${total}</b> 处` : ''].filter(Boolean).join(' · ')}，在 ${hit.length} 块里`
        : `八股检查：<span class="cw-ok">这一页${hasBagu() ? '没有禁用词和八股' : '没有禁用词'}</span>`;
    const list = hit.map((x) => `<div class="cw-ov"><b>${esc(x.s.label)}</b>　${x.words.length ? `禁用词：<span class="cw-err">${esc(x.words.join('、'))}</span>　` : ''}${x.total ? `八股 ${x.total} 处${x.must ? `（必改 ${x.must}）` : ''}：<span class="cw-dim">${esc(wordsText(x.found, 8, x.words))}</span>` : ''}</div>`).join('');
    const canFix = hasBagu() && hit.some((x) => x.total && !x.s.scanOnly);
    return `<div class="cw-bagubar ${hit.length ? 'hit' : ''}">
<div class="cw-row"><span class="cw-grow cw-small">${head}</span>${canFix ? btn('baguPage', `清理这一页（${hit.filter((x) => x.total && !x.s.scanOnly).length} 块）`, `data-page="${esc(id)}"`) : ''}</div>
${id === 'play' ? (hit.length ? '<div class="cw-dim cw-small">试玩回复里的八股不在这里改：多半是人设、开场白或基调带出来的，点评会告诉你去哪一页改。</div>' : '') : `<div class="cw-small cw-dim"><span class="cw-tok" data-tok-page="${esc(id)}">这一页 ${tokText(rows.map((x) => x.s.get()))}</span></div>`}
${hit.length ? `<details class="cw-mini"><summary>看是哪几块</summary>${list}</details>` : ''}
${!hasBagu() ? '<div class="cw-dim cw-small">装了八股清理扩展能扫出更多套路，还能一键改；现在只查禁用词。</div>' : id === 'play' ? '' : canFix ? '<div class="cw-dim cw-small">只改有八股的句子，每块 1–2 次调用。改完不满意可以“换回上一版”。</div>' : ''}
${last ? `<div class="cw-box cw-small">${last.map((r) => `<div><b>${esc(r.label)}</b>：${r.text}</div>`).join('')}</div>` : ''}
</div>`;
}

function clicheHtml(text, i) {
    if (!String(text ?? '').trim()) return '';
    const words = findWords(text, flow.banned(draft()));
    const opts = hasBagu() ? baguOptions(getCtx().extensionSettings, flow.banned(draft())) : null;
    const scan = opts ? baguScan(text, opts) : null;
    if (!words.length && !scan?.total) return '<div class="cw-small"><span class="cw-badge ok">没有禁用词和八股</span></div>';
    return `<div class="cw-box cw-small">${words.length ? `<div>禁用词：<b class="cw-err">${esc(words.join('、'))}</b></div>` : ''}${scan?.total ? `<div>八股 ${scan.total} 处：${esc(wordsText(scan.words, 8, words))}</div>` : ''}
${hasBagu() ? `<div class="cw-row">${btn('baguOne', '只清理这个人设', `data-i="${i}"`)}</div>` : ''}</div>`;
}

function personaHtml() {
    const d = draft();
    const mode = flow.modeOf(d);
    if (!d.personas?.length) {
        return mode === 'world'
            ? `<div class="cw-box">这是无固定角色的世界卡，主要角色可以不写：人物都放在 NPC 页的 NPC 库里，AI 按世界和 NPC 生成规则来演。想要几个固定出场的关键人物，也可以在这里加。</div><div class="cw-row">${btn('add', '加一个主要角色', 'data-path="personas" data-tpl="persona"')}</div>`
            : `<div class="cw-dim">先选一个构想。</div><div class="cw-row">${btn('add', '手动加一个主要角色', 'data-path="personas" data-tpl="persona"')}</div>`;
    }
    let html = `<div class="cw-row">${btn('qa', d.qa?.chars?.length ? '换一批问题' : '出问题（给脑洞）')}${btn('allPersonas', '生成全部人设')}${btn('add', '加一个主要角色', 'data-path="personas" data-tpl="persona"')}</div>
${mode === 'multi' ? '<div class="cw-dim cw-small">多人卡：每个人的人设都会参考其他主要角色，张力位置不重复；全部写完后在页面底部写“角色关系网”。</div>' : ''}
${styleRowHtml()}
<div class="cw-dim cw-small">想只改一小段：在框里选中那段，下面会出现“局部重写”。</div>`;
    (d.qa?.chars ?? []).forEach((c, ci) => {
        html += `<div class="cw-box"><div class="cw-sub">${esc(c.name)} 的问题</div>${c.questions.map((q, qi) => `<div class="cw-q"><div class="cw-qt">${esc(q.q)}</div>
${answerHtml(`qa.chars.${ci}.questions.${qi}.answer`, q.options, '或者自己写；留空让 AI 决定')}</div>`).join('')}</div>`;
    });
    const place = settings().personaPlace;
    d.personas.forEach((p, i) => {
        const pr = d.predict?.[p.name];
        html += `<div class="cw-card">
<div class="cw-row">${inp(`personas.${i}.name`, '名字（空着让 AI 起）', 'cw-grow')}${btn('persona', p.text ? '重写' : '写这个角色', `data-i="${i}" ${p.text ? '' : 'class="cw-primary"'}`)}${!p.text || p.added ? btn('del', '删', `data-path="personas" data-i="${i}"`) : ''}</div>
${inp(`personas.${i}.desc`, '一句设想：TA 是谁、和〔user〕和其他人什么关系（可空，空着让 AI 补一个卡里缺的人）')}
${listInp(`personas.${i}.keys`, '别名/称呼（绿灯关键词，逗号分隔）')}
${toolsHtml(`persona:${p.name}`, !!p.text)}
<div class="cw-sub">概要 <small class="cw-dim">${place === 'green' ? '蓝灯常驻' : '给后面步骤参考，不单独导入'}</small></div>${ta(`personas.${i}.overview`, 3)}
<div class="cw-sub">人设 <small class="cw-dim">${{ blue: '世界书 · 蓝灯常驻', green: '世界书 · 绿灯', description: '导入到角色描述' }[place] ?? ''}（在“设置”里改）</small></div>${ta(`personas.${i}.text`, 14)}
${storyHtml(p, i)}
${clicheHtml(p.text, i)}
${d.au ? auCheckHtml(p, i) : ''}
<div class="cw-row">${btn('predict', pr ? '再测一次' : '可预测性测试', `data-i="${i}"`)}${pr?.overlaps?.length ? btn('destale', `重写撞车的 ${pr.overlaps.length} 处`, `data-i="${i}" class="cw-primary"`) : ''}</div>
<div class="cw-dim cw-small">先让 AI 只看标签猜这类角色的刻板写法，再按意思比对人设。2 次调用。</div>
${pr ? `<div class="cw-box cw-small">${pr.rewritten ? `<span class="cw-badge ok">撞车的部分已重写，可以再测一次</span>${pr.fixed?.length ? `<div class="cw-dim">针对的是：${pr.fixed.map((f) => `「${esc(f.card)}」`).join('')}。改成了什么见上面“改了什么”。</div>` : ''}` : pr.overlaps.length ? pr.overlaps.map((o) => `<div class="cw-ov">卡里：<b>${esc(o.card)}</b><br><span class="cw-dim">撞上的刻板写法：${esc(o.text)}</span></div>`).join('') : '<span class="cw-badge ok">没撞上</span>'}
${pr.predicted ? `<details class="cw-mini"><summary>AI 猜的刻板写法</summary>${[...(pr.predicted.scenes ?? []).map((sc) => `${sc.scene}：${sc.behavior ?? ''}${sc.line ? `「${sc.line}」` : ''}`), ...(pr.predicted.traits ?? [])].map((x) => `<div>· ${esc(x)}</div>`).join('')}</details>` : ''}</div>` : ''}
</div>`;
    });
    if (d.personas.length > 1 || mode === 'multi') {
        html += `<div class="cw-card"><div class="cw-row"><b class="cw-grow">角色关系网</b>${btn('relations', d.relations ? '重写' : '生成', d.personas.filter((p) => p.text).length > 1 && !d.relations ? 'class="cw-primary"' : '')}</div>
<div class="cw-dim cw-small">多人卡最容易跑成单人卡：AI 只盯着一个人演。这一块写清主要角色之间的关系和账、修罗场怎么触发、一次回复里怎么安排几个人出场、群戏里各自说话的区别。蓝灯常驻，放在人设后面。</div>
${toolsHtml('relations', !!d.relations)}${ta('relations', 10, '<角色关系>…</角色关系>')}</div>`;
    }
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
    return `<div class="cw-row">${btn('npc', d.npcs.length ? '重写全部' : '生成 NPC')}${btn('add', '加一个 NPC', 'data-path="npcs" data-tpl="npc"')}</div>
<div class="cw-dim cw-small">加一个 NPC 后，可以先写名字和一句设想（比如“宫里的老太医，知道母蛊的来历”），点“写这个 NPC”只写这一个，别的不动；名字和设想都空着就让 AI 想一个这张卡缺的。</div>
${toolsHtml('npc', d.npcs.length > 0)}
${d.npcs.map((n, i) => `<div class="cw-card"><div class="cw-row">${inp(`npcs.${i}.name`, '名字（空着让 AI 起）', 'cw-grow')}${btn('npcOne', n.content?.trim() ? '重写这个' : '写这个 NPC', `data-i="${i}" ${n.content?.trim() ? '' : 'class="cw-primary"'}`)}${btn('del', '删', `data-path="npcs" data-i="${i}"`)}</div>
${inp(`npcs.${i}.desc`, '一句设想：他是谁、在剧情里干什么（可空）')}
${listInp(`npcs.${i}.keys`)}${ta(`npcs.${i}.content`, 7)}</div>`).join('')}`;
}

function routesHtml() {
    const d = draft();
    return `<div class="cw-dim cw-small">每条路线 = 一个〔user〕身份 + 一个时期。导入时只启用第一条，其余在“导入”里切换。</div>
<div class="cw-row">${btn('routes', d.routes.some((r) => r.info) && d.routes.some((r) => !r.info) ? '给新路线写信息' : '生成路线信息')}${btn('suggestRoutes', '想几条新路线')}${btn('add', '加一条路线', 'data-path="routes" data-tpl="route"')}</div>
${d.routeIdeas?.length ? `<div class="cw-box"><div class="cw-sub">新路线的点子 <small class="cw-dim">点“加上”才会加进去</small></div>${d.routeIdeas.map((r, i) => `<div class="cw-row"><div class="cw-grow"><b>${esc(r.name)}</b>｜${esc(r.user)} · ${esc(r.period)}<div class="cw-dim cw-small">${esc(r.why)}</div></div>${btn('addRouteIdea', '加上', `data-i="${i}"`)}</div>`).join('')}</div>` : ''}
<div class="cw-dim cw-small">有空着的路线时，“生成”只写空着的那几条，写好的不动。</div>
${toolsHtml('routes', d.routes.some((r) => r.info))}
${d.routes.map((r, i) => `<div class="cw-card"><div class="cw-row">${inp(`routes.${i}.name`, '路线名', 'cw-grow')}${btn('del', '删', `data-path="routes" data-i="${i}"`)}</div>
<div class="cw-row">${inp(`routes.${i}.user`, '〔user〕身份', 'cw-grow')}${inp(`routes.${i}.period`, '时期', 'cw-grow')}</div>
${ta(`routes.${i}.info`, 8, '<玩家信息>…</玩家信息>\n<关系指导>…</关系指导>')}</div>`).join('')}`;
}

/** 我的步骤的页面 */
function customHtml(st) {
    const d = draft();
    const i = (settings().customSteps ?? []).indexOf(st);
    const fi = d.free.findIndex((x) => x.fromStep === st.id);
    const f = d.free[fi];
    const name = st.name || '我的步骤';
    return `<div class="cw-row">${btn('custom', f?.content ? '重写' : '生成', `data-i="${i}"`)}${btn('editStep', '改这一步的提示词', `data-i="${i}"`)}</div>
${toolsHtml(`free:${name}`, !!f?.content)}
${f ? `<div class="cw-sub">${esc(name)} <small class="cw-dim">${f.light === 'green' ? '绿灯' : '蓝灯'} · ${f.position === 'before' ? '角色前' : '角色后'}，导入时进世界书</small></div>${ta(`free.${fi}.content`, 12)}` : '<div class="cw-dim">还没生成。</div>'}`;
}

function toneHtml() {
    const d = draft();
    const steps = settings().customSteps ?? [];
    return `<div class="cw-row">${btn('tone', d.tone ? '重写' : '生成基调与规则')}</div>
${toolsHtml('tone', !!d.tone)}
<div class="cw-sub">创作文体 <small class="cw-dim">蓝灯，放在角色定义之前</small></div>${ta('tone', 10)}
<div class="cw-sub">自由模块 <small class="cw-dim">系统面板、信物、预言……上面没覆盖的都放这里</small></div>
${d.free.map((f, i) => (f.fromStep ? '' : `<div class="cw-card"><div class="cw-row">${inp(`free.${i}.name`, '模块名', 'cw-grow')}${btn('free', '生成', `data-i="${i}"`)}${btn('del', '删', `data-path="free" data-i="${i}"`)}</div>
${inp(`free.${i}.desc`, '几句话描述它是什么')}
${f.name ? toolsHtml(`free:${f.name.trim()}`, !!f.content) : ''}
<div class="cw-row"><select class="text_pole" data-bind="free.${i}.light"><option value="blue" ${f.light !== 'green' ? 'selected' : ''}>蓝灯常驻</option><option value="green" ${f.light === 'green' ? 'selected' : ''}>绿灯（关键词触发）</option></select>
<select class="text_pole" data-bind="free.${i}.position"><option value="after" ${f.position !== 'before' ? 'selected' : ''}>角色定义之后</option><option value="before" ${f.position === 'before' ? 'selected' : ''}>角色定义之前</option></select></div>
${listInp(`free.${i}.keys`)}${ta(`free.${i}.content`, 6)}</div>`)).join('')}
<div class="cw-row">${btn('add', '加一个模块', 'data-path="free" data-tpl="free"')}</div>
${steps.length ? '' : '<div class="cw-dim cw-small">想在任意两步之间加自己的步骤：目录 → 提示词 → 我的步骤。</div>'}`;
}

function greetingHtml() {
    const d = draft();
    const s = settings();
    const routes = d.routes.length ? d.routes : [{ name: '主线' }];
    const presets = listPresets();
    return `<label class="cw-presetpick">开场白预设<select class="text_pole cw-in" data-set="presetGreeting"><option value="">不用预设</option>${presets.map((p) => `<option value="${esc(p)}" ${p === s.presetGreeting ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
<div class="cw-dim cw-small">${presets.length ? '选你平时玩卡用的正文预设，插件会把它打开的条目一起发出去，不会切换你酒馆当前的预设。' : '列表是空的：要先在酒馆里用“对话补全”类 API，才能读到预设。'}先想梗、挑梗，再扩写；扩写的开场白会加在这条路线后面，不会覆盖。“直接写”会替换这条路线原来的开场白（可以换回上一版）。</div>
${routes.map((r, i) => {
        const list = (d.greetings ?? []).map((g, gi) => ({ g, gi })).filter((x) => x.g.route === r.name);
        const hooks = d.hooks?.[r.name] ?? [];
        const on = hooks.filter((h) => h.on).length;
        return `<div class="cw-card"><div class="cw-row"><b class="cw-grow">${esc(r.name)}</b></div>
<div class="cw-sub">① 想梗 <small class="cw-dim">勾选喜欢的，可以直接改字，也可以自己写</small></div>
<div class="cw-row">${btn('hooks', hooks.length ? '再想 5 个' : '想 5 个梗', `data-i="${i}"`)}</div>
${hooks.map((h, hi) => `<div class="cw-hook ${h.on ? 'on' : ''} ${h.used ? 'used' : ''}"><input type="checkbox" class="cw-hookcheck" data-r="${i}" data-h="${hi}" ${h.on ? 'checked' : ''}><textarea class="text_pole cw-hooktext" data-r="${i}" data-h="${hi}" rows="2">${esc(h.text)}</textarea><span class="cw-x" data-act="delHook" data-r="${i}" data-h="${hi}" title="删掉">×</span></div>${h.used ? '<div class="cw-dim cw-small cw-usedtag">已扩写过</div>' : ''}`).join('')}
<div class="cw-row"><input class="text_pole cw-in cw-grow cw-newhook" data-r="${i}" placeholder="自己写一个梗：在哪、发生了什么、停在哪">${btn('addHook', '加上', `data-i="${i}"`)}</div>
<div class="cw-sub">② 扩写成开场白</div>
<div class="cw-row">${on ? `<div class="menu_button cw-btn cw-primary" data-act="expand" data-i="${i}">扩写勾选的 ${on} 个 →</div>` : '<span class="cw-dim cw-small">勾选上面的梗再扩写</span>'}${btn('greet', '不想梗，直接写', `data-i="${i}"`)}</div>
${toolsHtml(`greet:${r.name}`, list.length > 0)}
${list.map(({ gi }) => `<div class="cw-row cw-end">${btn('del', '删', `data-path="greetings" data-i="${gi}"`)}</div>${ta(`greetings.${gi}.text`, 10)}`).join('')}</div>`;
    }).join('')}
<div class="cw-dim cw-small">第一条路线的第一个开场白会成为主开场白，其余按路线顺序放进额外开场白。</div>`;
}

const PAGE_NAMES = { persona: '主要人设', world: '世界观', npc: 'NPC', routes: '玩家与路线', tone: '基调与规则', greet: '开场白' };

function playHtml() {
    const d = draft();
    const p = d.play ?? {};
    const list = flow.playGreetings(d);
    if (!list.length) return '<div class="cw-dim">先去开场白页写一个开场白。</div>';
    const s = settings();
    const msgs = p.messages ?? [];
    const name = flow.charName(d);
    const userName = String(p.userName ?? '').trim() || s.userToken || '<user>';
    let html = `<div class="cw-dim cw-small">用“开场白预设”跑几轮，看角色跑起来是什么样。发出去的设定和导入酒馆后一样：蓝灯条目、这条路线、最近几条消息里提到关键词的绿灯。</div>
<label class="cw-presetpick">从哪个开场白开始<select class="text_pole cw-in" data-bind="play.greet">${list.map((g, i) => `<option value="${i}" ${Number(p.greet ?? 0) === i ? 'selected' : ''}>${esc(g.label)}：${esc(g.text.replace(/\s+/g, ' ').slice(0, 24))}…</option>`).join('')}</select></label>
<div class="cw-row">${inp('play.userName', `试玩时 user 叫什么（空着就是 ${s.userToken || '<user>'}）`, 'cw-grow')}${btn('playStart', msgs.length ? '重新开始' : '开始', msgs.length ? '' : 'class="cw-primary"')}</div>`;
    if (!msgs.length) return html;
    const sent = flow.playContext(d);
    const sentItems = [...sent.before, ...sent.card, ...sent.after];
    html += `<div class="cw-dim cw-small">这一轮发出去的设定：${sentItems.length} 块，${tokSpan(sentItems.map((x) => x.text))}${sentItems.length ? `<details class="cw-mini"><summary>是哪几块</summary>${sentItems.map((x) => `<div class="cw-tokrow"><span class="cw-grow">${esc(x.label)}</span>${tokSpan([x.text])}</div>`).join('')}</details>` : ''}</div>`;
    html += `<div class="cw-chat">${msgs.map((m, i) => `<div class="cw-msg ${m.role}"><div class="cw-row cw-msghead"><b class="cw-grow">${i + 1}. ${esc(m.role === 'char' ? name : userName)}</b>${i === msgs.length - 1 && i > 0 && m.role === 'char' ? btn('playRedo', '重来这条') : ''}${i > 0 ? btn('playCut', '删到这里', `data-i="${i}"`) : ''}</div><div class="cw-msgtext">${esc(m.text).replace(/\n/g, '<br>')}</div></div>`).join('')}</div>`;
    const last = msgs.at(-1);
    html += `<div class="cw-box">
<textarea class="text_pole cw-ta" data-bind="play.input" rows="2" placeholder="以 user 的身份说点什么，或者让 AI 帮你写一句">${esc(p.input ?? '')}</textarea>
<div class="cw-row">${btn('playSend', last.role === 'user' ? '让角色回复' : '发送', 'class="cw-primary"')}${btn('playUserOnce', 'AI 帮我写一句')}</div>
<div class="cw-row"><span>让 AI 扮</span><select class="text_pole cw-in" data-bind="play.style" style="width:auto">${Object.keys(flow.PLAY_STYLES).map((k) => `<option value="${k}" ${(p.style ?? '普通') === k ? 'selected' : ''}>${k}的玩家</option>`).join('')}</select><span>跑</span><input class="text_pole cw-num" type="number" min="1" max="10" data-bind="play.rounds" value="${esc(p.rounds ?? 3)}"><span>轮</span>${btn('playAuto', '开跑')}</div>
<div class="cw-dim cw-small">${esc(flow.PLAY_STYLES[p.style ?? '普通'] ?? '')} 每轮 2 次调用。</div>
</div>
<div class="cw-row">${btn('playReview', p.review ? '再点评一次' : '试玩点评', msgs.length >= 3 ? 'class="cw-primary"' : '')}<span class="cw-dim cw-small cw-grow">看 OOC、抢话、八股、重复、角色会不会主动推剧情，问题出在卡的哪一部分。1 次调用。</span></div>`;
    const r = p.review;
    if (r) {
        html += `<div class="cw-box"><div class="cw-sub">点评${r.score ? `：${r.score} / 10` : ''}</div>
${r.good.length ? `<div class="cw-small"><b>好的地方</b>${r.good.map((g) => `<div>· ${esc(g)}</div>`).join('')}</div>` : ''}
${r.issues.length ? r.issues.map((x, i) => `<div class="cw-ov cw-small"><div><span class="cw-badge">${esc(PAGE_NAMES[x.part] ?? x.part)}${x.name ? ` · ${esc(x.name)}` : ''}</span> ${x.where ? `<span class="cw-dim">${esc(x.where)}</span> ` : ''}${esc(x.problem)}</div>
${x.fix ? `<div>改法：${esc(x.fix)}</div>` : ''}<div class="cw-row">${btn('playFix', `带着这条意见去“${esc(PAGE_NAMES[x.part] ?? x.part)}”`, `data-i="${i}"`)}</div></div>`).join('') : '<span class="cw-badge ok">没挑出问题</span>'}
</div>`;
    }
    return html;
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
    html += blueHtml();
    html += `<div class="cw-dim cw-small">可预测性测试在“主要人设”里每个角色下面。阈值 ${s.predictThreshold}，在设置里改。</div>`;
    return html;
}

function importHtml() {
    const d = draft();
    if (d.existing) return writeBackHtml() + blueHtml() + `<details class="cw-mini"><summary>另存为一张新卡</summary>${newCardHtml()}</details>`;
    return newCardHtml() + blueHtml();
}

function writeBackHtml() {
    const d = draft();
    const ex = d.existing;
    const fresh = orderedGreetings(d).length;
    const b = ex.backup;
    return `<div class="cw-card"><div class="cw-sub">写回原卡：${esc(ex.name)}</div>
<div class="cw-small">会更新：角色描述/性格/场景/对话示例、原来的开场白${fresh ? `，再加 ${fresh} 个新开场白` : ''}；世界书 ${esc(ex.world || `（新建：${ex.name}）`)} 里原有的条目改内容，写卡工坊的条目（人设、世界观、NPC、路线、基调、模块）有就改、没有就新建。不会删条目。原卡已经有启用的路线时，新路线默认不启用，在下面切换。</div>
<div class="cw-row"><div class="menu_button cw-btn cw-primary" data-act="writeBack">写回原卡</div>${b ? btn('undoWriteBack', `撤销上次写回（${new Date(b.time).toLocaleTimeString()}）`) : ''}</div>
${d.routes.length > 1 ? `<div class="cw-row"><select class="text_pole cw-grow cw-route">${d.routes.map((r, i) => `<option value="${i}">${esc(r.name)}</option>`).join('')}</select>${btn('switchRoute', '切换到这条路线')}</div>` : ''}
</div>`;
}

function newCardHtml() {
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
<label class="cw-presetpick">简介风格<select class="text_pole cw-in cw-introstyle"><option value="0">默认</option>${(settings().introStyles ?? []).map((x, i) => `<option value="${i + 1}" ${Number(settings().introStyle) === i + 1 ? 'selected' : ''}>${esc(x.name || `风格 ${i + 1}`)}</option>`).join('')}</select></label>
<div class="cw-dim cw-small">换风格只是重新排版，不调 API。风格在“提示词 → 简介风格”里存，可以存好几个。</div>
${ta('intro.text', 16)}
<div class="cw-row"><span class="cw-dim cw-grow cw-len">${len} 字${len > 2000 ? '（超过 2000，非 Nitro 要拆两条）' : ''}</span>${btn('copyIntro', '复制')}${btn('saveIntro', '写进角色卡')}</div>
${it.parts && Object.keys(it.parts).length ? `<details class="cw-mini"><summary>分段修改（改完点“重新排版”）</summary>
${['题句', '简介', '关于TA', '路线', '内心想法'].map((k) => `<div class="cw-sub">${k}</div><textarea class="text_pole cw-ta" data-bind="intro.parts.${k}" rows="3">${esc(it.parts[k] ?? '')}</textarea>`).join('')}
<div class="cw-row">${btn('recompose', '重新排版')}</div></details>` : ''}
<div class="cw-dim cw-small">作者名、授权、预设参考在“设置”里填。</div>`;
}

const STEP_TEMPLATE = '【任务】为这张卡写……\n\n【构想】\n{{concept}}\n【主要角色概要】\n{{overviews}}\n\n【写法规则】\n{{rules.通用}}';

function promptsHtml() {
    const s = settings();
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const tabs = [['step', '每一步的提示词'], ['rule', '规则库'], ['style', '文风'], ['tag', '我的标签'], ['mine', '我的步骤'], ['intro', '简介风格']];
    let body = '';
    if (state.ptab === 'step') {
        const id = state.editStep;
        body = `<div class="cw-dim cw-small">选一个步骤，直接在框里改或者整段粘贴你自己的提示词，自动保存。改坏了点“恢复默认”。用 {{变量}} 引用前面步骤的产出，下面有列表。</div>
<select class="text_pole cw-step-sel">${Object.keys(DEFAULT_PROMPTS).map((k) => opt(k, `${STEP_INFO[k]?.name ?? k}${s.prompts[k]?.trim() ? '（已改）' : ''}`, id)).join('')}</select>
<textarea class="text_pole cw-ta cw-step-ta" rows="16">${esc(s.prompts[id]?.trim() ? s.prompts[id] : DEFAULT_PROMPTS[id])}</textarea>
<div class="cw-row">${btn('resetStep', '恢复这一步的默认')}</div>
<details class="cw-mini"><summary>可用变量</summary><div class="cw-small">${Object.entries(TEMPLATE_VARS).map(([k, v]) => `<code>{{${esc(k)}}}</code> ${esc(v)}`).join('<br>')}</div></details>
<div class="cw-sub">目录里的步骤</div>
<div class="cw-dim cw-small">用不上的步骤可以关掉：目录里不显示，一键出卡也跳过。随时可以再打开，写好的内容不会丢。</div>
<div class="cw-chips">${PAGES.filter((pg) => OPTIONAL_PAGES.includes(pg.id)).map((pg) => `<label class="cw-chip ${(s.offPages ?? []).includes(pg.id) ? '' : 'on'}"><input type="checkbox" class="cw-pageon" data-page="${pg.id}" ${(s.offPages ?? []).includes(pg.id) ? '' : 'checked'}>${esc(pg.name)}</label>`).join('')}</div>`;
    } else if (state.ptab === 'rule') {
        const list = flow.ruleList();
        if (!list.some((r) => r.name === state.editRule)) state.editRule = list[0]?.name;
        const r = list.find((x) => x.name === state.editRule);
        const k = r.name;
        const inPrompt = Object.keys(DEFAULT_PROMPTS).filter((id) => {
            const tpl = s.prompts[id]?.trim() ? s.prompts[id] : DEFAULT_PROMPTS[id];
            return tpl.includes(`{{rules.${k}}}`) || (k === '人设模板' && tpl.includes('{{template}}'));
        });
        const stepName = (id) => STEP_INFO[id]?.name ?? id;
        const tag = (x) => `${x.name}${!x.builtin ? '（自己加的）' : x.edited ? '（已改）' : ''}${x.on ? '' : '（关）'}${x.mode !== 'all' ? `（${CARD_MODES[x.mode]?.slice(0, 3) ?? x.mode}）` : ''}`;
        body = `<div class="cw-dim cw-small">规则库里每一条都是一个可以插拔的模块：可以开关、改内容、限定只给某种卡用、插到任意步骤里。提示词里写了 {{rules.名称}} 的步骤会在那个位置用它；“另外插到”的步骤会把它加在提示词最后。也可以新建自己的规则（比如你的世界观教程、某个题材的写法）。</div>
<select class="text_pole cw-rule-sel">${list.map((x) => opt(x.name, tag(x), k)).join('')}</select>
<div class="cw-row"><label class="checkbox_label"><input type="checkbox" class="cw-rule-on" ${r.on ? 'checked' : ''}>启用</label>
<select class="text_pole cw-rule-mode" style="width:auto">${[['all', '所有卡都用'], ['single', '只用于单人卡'], ['multi', '只用于多人卡'], ['world', '只用于世界卡']].map(([v, n]) => opt(v, n, r.mode)).join('')}</select></div>
${k === '人设模板' ? '<div class="cw-dim cw-small">写人设时让 AI 照着填的模板。{{name}} 会换成角色名。用不上的字段 AI 会删掉。</div>' : ''}
<textarea class="text_pole cw-ta cw-rule-ta" rows="14">${esc(r.text)}</textarea>
<div class="cw-small">写在这些步骤的提示词里：${inPrompt.length ? inPrompt.map((id) => `<span class="cw-badge">${esc(stepName(id))}</span>`).join(' ') : '<span class="cw-dim">没有</span>'}</div>
<details class="cw-mini" ${r.steps.length ? 'open' : ''}><summary>另外插到这些步骤（${r.steps.length} 个）</summary><div class="cw-chips">${Object.keys(DEFAULT_PROMPTS).filter((id) => !inPrompt.includes(id)).map((id) => `<label class="cw-chip ${r.steps.includes(id) ? 'on' : ''}"><input type="checkbox" class="cw-rulestep" data-step="${id}" ${r.steps.includes(id) ? 'checked' : ''}>${esc(stepName(id))}</label>`).join('')}</div></details>
<div class="cw-row">${r.builtin ? btn('resetRule', '恢复这条的默认') : btn('delRule', '删除这条规则')}</div>
<div class="cw-row"><input class="text_pole cw-in cw-grow cw-newrule" placeholder="新规则的名字，比如：世界观写法、宫斗题材"> ${btn('addRule', '新建规则')}</div>`;
    } else if (state.ptab === 'style') {
        body = `<div class="cw-dim cw-small">文风只管“怎么写”：用词、句子长短、语气、比喻多不多。可以存好几个，在“主要人设”页顶部给每张卡选一个。选了之后，写人设、展开经历、重写撞车、按意见改人设、局部重写人设都会带上；勾“其他也用”时世界观、NPC、路线、模块、开场白也带上。格式要求（YAML、标签）不受影响。</div>
${(settings().styles ?? []).map((x, i) => `<div class="cw-card">
<input class="text_pole cw-in cw-stname" data-i="${i}" value="${esc(x.name)}" placeholder="文风名">
<textarea class="text_pole cw-ta cw-sttext" data-i="${i}" rows="8" placeholder="比如：\n- 短句，少用形容词，动作和对白多于心理描写\n- 口语化，像在讲别人的八卦\n- 可以粘一段你喜欢的文字当样例，写明“学它的语气，不抄内容”">${esc(x.text)}</textarea>
<div class="cw-row cw-end">${btn('delStyle', '删除这个文风', `data-i="${i}"`)}</div></div>`).join('')}
<div class="cw-row">${btn('addStyle', '新建一个文风')}</div>`;
    } else if (state.ptab === 'tag') {
        body = `<div class="cw-dim cw-small">每行一个：名称|触发词,触发词。触发词出现在一句话脑洞里就自动勾上。</div>
<select class="text_pole cw-dim-sel">${lib().map((d) => opt(d.key, d.name, state.editDim)).join('')}</select>
<textarea class="text_pole cw-ta cw-dim-ta" rows="6" placeholder="蒸汽朋克|蒸汽,齿轮城">${esc((s.customTags[state.editDim] ?? []).join('\n'))}</textarea>`;
    } else if (state.ptab === 'intro') {
        body = `<div class="cw-dim cw-small">简介的排版模板。{{标题}} {{题句}} 这类会换成内容；{{#路线}}……{{/路线}} 表示这一块没内容就整段省略；{{路线|引用}} 表示每行前加 &gt;。可用：${INTRO_VARS.map((v) => `{{${v}}}`).join(' ')}。</div>
<details class="cw-mini"><summary>默认风格（只读，可以复制一份来改）</summary><textarea class="text_pole cw-ta" rows="12" readonly>${esc(DEFAULT_INTRO_STYLE)}</textarea></details>
${(s.introStyles ?? []).map((x, i) => `<div class="cw-card">
<input class="text_pole cw-in cw-isname" data-i="${i}" value="${esc(x.name)}" placeholder="风格名">
<textarea class="text_pole cw-ta cw-istpl" data-i="${i}" rows="14">${esc(x.tpl)}</textarea>
<div class="cw-row cw-end">${btn('delIntroStyle', '删除这个风格', `data-i="${i}"`)}</div></div>`).join('')}
<div class="cw-row">${btn('addIntroStyle', '复制默认风格，新建一个')}</div>`;
    } else {
        body = `<div class="cw-dim cw-small">自己加的步骤会作为单独一页插进目录，放在你选的那一步后面。产出写成一个自由模块，导入时进世界书。</div>
${(s.customSteps ?? []).map((st, i) => `<div class="cw-card">
<input class="text_pole cw-in" data-step="${i}" data-key="name" value="${esc(st.name)}" placeholder="步骤名（也是模块名）">
<label class="cw-presetpick">放在哪一步后面<select class="text_pole cw-in" data-step="${i}" data-key="after">${PAGES.map((p, pi) => opt(p.id, `${pi + 1}. ${p.name}`, st.after || 'tone')).join('')}</select></label>
<label class="checkbox_label cw-small"><input type="checkbox" data-step="${i}" data-key="auto" ${st.auto ? 'checked' : ''}>一键出卡时也跑这一步</label>
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
    TOKREF.clear();
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

/** 没有路线时补一条“主线”，保证梗和开场白有地方放 */
function ensureRoute(i) {
    const d = draft();
    if (!d.routes.length) d.routes.push({ name: '主线', user: '', period: '', info: '' });
    return Math.min(i, d.routes.length - 1);
}
const routeAt = (i) => draft().routes[i] ?? { name: '主线' };

const TEMPLATES = {
    extra: () => ({ name: '', keys: [], content: '' }),
    npc: () => ({ name: '', desc: '', keys: [], content: '' }),
    persona: () => ({ name: '', desc: '', keys: [], overview: '', text: '', added: true }),
    route: () => ({ name: `路线${draft().routes.length + 1}`, user: '', period: '', info: '' }),
    free: () => ({ name: '', desc: '', content: '', light: 'blue', keys: [], position: 'after' }),
};

async function autoRun() {
    const d = draft();
    const s = settings();
    if (!d.idea.trim() && !d.concepts.length && !d.existing && !d.au) {
        toastr.info('先写一句话脑洞，或者点“没想法？掷骰子”', '写卡工坊');
        return;
    }
    await step(async () => {
        const tick = () => { saveDraft(); renderAll(); setBusy(true); };
        const on = (id) => !(s.offPages ?? []).includes(id);
        // 勾了“一键出卡时也跑”的我的步骤，跟在对应那一步后面
        const mine = async (after) => {
            for (const st of s.customSteps ?? []) {
                if (!st.auto || (st.after || 'tone') !== after) continue;
                if (d.free.find((x) => x.fromStep === st.id)?.content) continue;
                await flow.custom(d, st); tick();
            }
        };
        if (d.au) {
            // AU：先补内核和映射表，再走正常流程（不出构想）
            if (!d.au.core.some((c) => c.text.trim())) { await flow.auCore(d); tick(); }
            if (!d.au.map) {
                if (!d.idea.trim()) throw new Error('先在“AU 内核与映射”页写 AU 设定');
                await flow.auMap(d); tick();
            }
            for (const p of d.personas) {
                if (!p.text) { setStatus(`AU 人设：${esc(p.name)}…`); await flow.persona(d, p.name); tick(); }
                if (s.autoBackstory && thinLifeStory(p.text)) { setStatus(`展开经历：${esc(p.name)}…`); await flow.backstory(d, p.name); tick(); }
                if (s.autoPredict && !d.au.checks[p.name]) {
                    const c = await flow.auCheck(d, p.name);
                    if (c.items.some((x) => x.verdict !== '保留') || c.leftovers.length) await flow.auFix(d, p.name);
                    tick();
                }
            }
            await mine('persona');
            if (!d.world.main) { await flow.world(d); tick(); }
            await mine('world');
            if (!d.npcs.length) { await flow.npc(d); tick(); }
            await mine('npc');
            if (!d.routes.length || d.routes.some((r) => !r.info)) { await flow.routes(d); tick(); }
            await mine('routes');
            if (!d.tone) { await flow.tone(d); tick(); }
            await mine('tone');
            for (let i = 0; i < d.routes.length; i++) {
                if (!d.greetings.some((g) => g.route === d.routes[i].name)) { setStatus(`开场白：${esc(d.routes[i].name)}…`); await greetClean(() => flow.greetings(d, i)); tick(); }
            }
            await mine('greet');
            if (s.autoBagu && hasBagu()) { await baguFix(); tick(); }
            state.checks = flow.localCheck(d);
            state.page = 'check';
            return 'AU 卡写好了。看一下质检结果，没问题就导入（会存成一张新卡，原卡不动）。';
        }
        if (d.existing) {
            // 已有的卡：只补空着的路线和没开场白的路线，原来的不动
            if (d.routes.some((r) => !r.info)) { await flow.routes(d); tick(); }
            for (let i = 0; i < d.routes.length; i++) {
                const r = d.routes[i];
                if (!r.orig && !d.greetings.some((g) => g.route === r.name)) { setStatus(`开场白：${esc(r.name)}…`); await greetClean(() => flow.greetings(d, i)); tick(); }
            }
            if (s.autoBagu && hasBagu()) { await baguFix(); tick(); }
            state.checks = flow.localCheck(d);
            state.page = 'check';
            return '补全了。看一下质检结果，没问题就到“导入酒馆”页写回原卡。';
        }
        if (!d.concepts.length) { await flow.idea(d); tick(); }
        if (d.pick < 0 || !d.concepts[d.pick]) { flow.pickConcept(d, 0); tick(); }
        await mine('idea'); await mine('tags');
        for (let i = 0; i < d.personas.length; i++) {
            const p = d.personas[i];
            if (!p.text) { setStatus(`人设：${esc(p.name || '新角色')}…`); await flow.persona(d, i); tick(); }
            if (s.autoBackstory && thinLifeStory(p.text)) { setStatus(`展开经历：${esc(p.name)}…`); await flow.backstory(d, p.name); tick(); }
        }
        if (d.personas.filter((p) => p.text).length > 1 && !d.relations) { setStatus('角色关系网…'); await flow.relations(d); tick(); }
        await mine('persona');
        if (on('world') && !d.world.main) { await flow.world(d); tick(); }
        await mine('world');
        if (on('npc') && !d.npcs.length && ((d.concepts[d.pick]?.npcs ?? 0) > 0 || flow.modeOf(d) === 'world')) { await flow.npc(d); tick(); }
        await mine('npc');
        if (on('routes') && d.routes.some((r) => !r.info)) { await flow.routes(d); tick(); }
        await mine('routes');
        if (on('tone') && !d.tone) { await flow.tone(d); tick(); }
        await mine('tone');
        if (!d.routes.length) d.routes = [{ name: '主线', user: '', period: '', info: '' }];
        for (let i = 0; i < d.routes.length; i++) {
            if (!d.greetings.some((g) => g.route === d.routes[i].name)) { setStatus(`开场白：${esc(d.routes[i].name)}…`); await greetClean(() => flow.greetings(d, i)); tick(); }
        }
        await mine('greet');
        if (s.autoPredict && on('check')) {
            for (const p of d.personas.filter((x) => x.text)) {
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

/** 好几块一起清理：句子合在一起分批发，结果写回各块 */
async function baguMany(slots, { onlyMust = false, label = '八股清理' } = {}) {
    const opts = baguOptions(getCtx().extensionSettings, flow.banned(draft()));
    const res = await baguRewriteMany(slots.map((x) => ({ text: x.get(), kind: x.kind })), opts,
        (system, user) => llm({ system, user, stage: 'card' }),
        () => state.abort,
        {
            onlyMust,
            onProgress: ({ sent, rounds, retry, sentences }) => setStatus(retry
                ? `${label}：没改好的句子再来一轮…`
                : `${label}：${slots.length} 块共 ${sentences} 句，第 ${sent}/${rounds} 批…`),
        });
    const report = [];
    let changed = 0;
    res.forEach((r, i) => {
        if (r.changed) { slots[i].set(r.text); changed += r.changed; }
        report.push({ label: slots[i].label, text: `改了 ${r.changed} 句${r.failed.length ? `，<span class="cw-warntext">${r.failed.length} 句没改好：${esc(r.failed.join('、'))}</span>` : ''}` });
    });
    return { report, changed };
}

async function baguFix() {
    const opts = baguOptions(getCtx().extensionSettings, flow.banned(draft()));
    // 规则清单本来就列着禁用词，改不了也不该改
    const slots = flow.textSlots(draft()).filter((x) => !x.rules && !isInstructions(x.get()) && baguScan(x.get(), opts).total);
    const { report } = slots.length ? await baguMany(slots) : { report: [] };
    state.bagu = report.length ? report : [{ label: '八股清理', text: '没有需要改的句子' }];
}

const greetCleanNote = () => (state.greetCleaned ? `顺手改掉了 ${state.greetCleaned} 句带必改词的。` : '');

/** 开场白一写完就只改必改词（禁用词、我的八股词）那几句 */
async function greetClean(fn) {
    const d = draft();
    const before = new Set(d.greetings ?? []);
    const out = await fn();
    if (!settings().greetMustClean || !hasBagu() || state.abort) return out;
    const opts = baguOptions(getCtx().extensionSettings, flow.banned(d));
    const fresh = (d.greetings ?? []).filter((g) => !before.has(g) && baguScan(g.text, opts).must);
    if (!fresh.length) return out;
    const { changed } = await baguMany(fresh.map((g, i) => ({ label: `新开场白 ${i + 1}`, kind: '开场白', get: () => g.text, set: (v) => { g.text = v; } })), { onlyMust: true, label: '开场白必改词' });
    state.greetCleaned = changed;
    return out;
}

/** 一页里各块的“换回上一版”用的键 */
function pageHistoryKeys(d, id) {
    if (id.startsWith('step:')) return d.free.filter((f) => `step:${f.fromStep}` === id).map((f) => `free:${f.name}`);
    return {
        persona: () => [...d.personas.map((p) => `persona:${p.name}`), 'relations'],
        world: () => ['world'],
        npc: () => ['npc'],
        routes: () => ['routes'],
        tone: () => d.free.filter((f) => !f.fromStep && f.name?.trim()).map((f) => `free:${f.name.trim()}`),
        greet: () => [...new Set((d.greetings ?? []).map((g) => g.route))].map((r) => `greet:${r}`),
        intro: () => ['intro'],
        au: () => ['au:core'],
        existing: () => d.existing ? [
            ...['description', 'personality', 'scenario'].map((k) => `exist:field:${k}`),
            ...d.existing.entries.map((e) => `exist:entry:${e.uid}`),
            ...d.existing.greetings.map((_, i) => `exist:greet:${i}`),
        ] : [],
    }[id]?.() ?? [];
}

/** 只清理一页：有八股的块逐个送去改写，旧版本存进“换回上一版” */
async function baguPage(id) {
    const d = draft();
    let report = [];
    let changed = 0;
    // 先存一份，清理完不满意可以在各块的“换回上一版”找回
    const keys = pageHistoryKeys(d, id);
    const snap = keys.map((k) => [k, structuredClone(flow.slotOf(d, k)?.get())]);
    const slots = scanPage(id).filter((x) => x.total && !x.s.scanOnly).map((x) => x.s);
    if (slots.length) ({ report, changed } = await baguMany(slots));
    if (id === 'intro' && d.intro?.parts && Object.keys(d.intro.parts).length) d.intro.text = flow.composeIntroFor(d);
    for (const [k, v] of snap) {
        if (JSON.stringify(v) !== JSON.stringify(flow.slotOf(d, k)?.get())) flow.remember(d, k, v);
    }
    state.baguPage = { page: id, report: report.length ? report : [{ label: '八股清理', text: '没有要改的句子' }] };
    return changed ? `这一页改了 ${changed} 句。` : '这一页没有要改的句子。';
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

async function fetchCard(avatar) {
    const c = getCtx();
    const res = await fetch('/api/characters/get', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
    if (!res.ok) throw new Error('读不到这张卡（可能改名或删了）');
    return await res.json();
}

async function mergeCard(avatar, data) {
    const c = getCtx();
    const top = Object.fromEntries(['description', 'personality', 'scenario', 'first_mes', 'mes_example'].filter((k) => k in data).map((k) => [k, data[k]]));
    const res = await fetch('/api/characters/merge-attributes', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ avatar, ...top, data }) });
    if (!res.ok) throw new Error(`保存角色卡失败（HTTP ${res.status}）`);
    await c.getCharacters?.();
    // 酒馆里正开着这张卡时，同步编辑框
    const open = c.characters?.[c.characterId];
    if (open?.avatar === avatar) {
        const boxes = { description: '#description_textarea', personality: '#personality_textarea', scenario: '#scenario_pole', first_mes: '#firstmessage_textarea', mes_example: '#mes_example_textarea' };
        for (const [k, sel] of Object.entries(boxes)) if (k in data) $(sel).val(data[k]);
    }
}

async function loadExisting(avatar) {
    await step(async () => {
        const card = await fetchCard(avatar);
        const worldName = card.data?.extensions?.world || '';
        let worldData = null;
        if (worldName) {
            const W = await worldApi();
            try { worldData = await W.load(worldName); } catch { worldData = null; }
        }
        pushHistory();
        const d = flow.loadCard(card, worldData, worldName);
        d.existing.avatar = avatar;
        settings().draft = d;
        state.checks = null; state.bagu = null;
        state.page = 'existing';
        return `读进来了：${esc(d.name)}。${d.personas.length} 个人设、${d.routes.length} 条路线、${d.existing.entries.length} 个其他条目、${d.existing.greetings.length} 个开场白。`;
    });
}

async function writeBack() {
    const c = getCtx();
    const s = settings();
    const d = draft();
    const ex = d.existing;
    if (!ex) return;
    const ok = await c.callGenericPopup(`把改动写回“${esc(ex.name)}”？<br>会先备份，可以一键撤销。`, c.POPUP_TYPE.CONFIRM);
    if (!ok) return;
    await step(async () => {
        const token = s.userToken || '<user>';
        const clean = mapStrings(structuredClone(d), (x) => unshield(x, token));
        const card = await fetchCard(ex.avatar);
        const W = await worldApi();
        let worldName = card.data?.extensions?.world || '';
        let worldData = null;
        if (worldName) { try { worldData = await W.load(worldName); } catch { worldData = null; } }
        const backup = {
            time: Date.now(),
            avatar: ex.avatar,
            card: Object.fromEntries(['description', 'personality', 'scenario', 'mes_example', 'first_mes', 'alternate_greetings', 'character_book'].map((k) => [k, card.data?.[k] ?? null])),
            world: worldName,
            worldData: worldData ? structuredClone(worldData) : null,
        };
        const merged = mergeWorld(worldData ?? { entries: {} }, clean, { personaPlace: s.personaPlace === 'description' ? 'blue' : s.personaPlace });
        const hasEntries = Object.keys(merged.entries).length > 0;
        if (hasEntries) {
            if (!worldName) worldName = uniqueName(ex.name, W.names());
            await W.save(worldName, merged);
            await W.refresh();
            W.reload(worldName);
        }
        const up = cardUpdate(clean);
        const data = { ...up, ...(hasEntries ? { extensions: { world: worldName }, character_book: worldToBook(worldName, merged) } : {}) };
        await mergeCard(ex.avatar, data);
        ex.backup = { ...backup, createdWorld: !backup.world && hasEntries ? worldName : '' };
        ex.world = worldName;
        // 新开场白已经进了原卡
        ex.greetings = [up.first_mes, ...up.alternate_greetings].filter((t) => String(t).trim());
        d.greetings = [];
        toastr.success(`已写回：${ex.name}`, '写卡工坊');
        return `已写回原卡“${esc(ex.name)}”。开场白只对新开的聊天生效；新路线默认没启用，在下面切换。`;
    });
}

async function undoWriteBack() {
    const c = getCtx();
    const d = draft();
    const b = d.existing?.backup;
    if (!b) return;
    if (!(await c.callGenericPopup(`撤销 ${new Date(b.time).toLocaleString()} 的写回？`, c.POPUP_TYPE.CONFIRM))) return;
    await step(async () => {
        const W = await worldApi();
        if (b.world && b.worldData) { await W.save(b.world, b.worldData); W.reload(b.world); }
        const data = { ...b.card };
        for (const k of Object.keys(data)) if (data[k] === null) data[k] = k === 'character_book' ? '__@@UNSET@@__' : '';
        data.extensions = { world: b.world || '' };
        await mergeCard(b.avatar, data);
        d.existing.greetings = [b.card.first_mes, ...(b.card.alternate_greetings ?? [])].filter((t) => String(t ?? '').trim());
        d.existing.world = b.world;
        d.existing.backup = null;
        return `撤销了。${b.createdWorld ? `写回时新建的世界书“${esc(b.createdWorld)}”还在，只是不再绑定，不要的话可以在酒馆里删掉。` : ''}`;
    });
}

async function switchRoute(i) {
    const d = draft();
    const r = d.routes[i];
    const worldName = d.existing?.world || d.imported?.world;
    if (!worldName || !r) return toastr.info(d.existing ? '先写回原卡' : '先导入酒馆', '写卡工坊');
    await step(async () => {
        const W = await worldApi();
        const data = await W.load(worldName);
        let n = 0;
        for (const e of Object.values(data?.entries ?? {})) {
            if (!String(e.comment ?? '').startsWith('路线·')) continue;
            e.disable = e.comment !== `路线·${r.name}`;
            n++;
        }
        if (!n) throw new Error('世界书里没找到路线条目');
        await W.save(worldName, data);
        W.reload(worldName);
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
    if (!d || (!d.idea?.trim() && !d.concepts?.length && !d.existing && !d.au && !d.personas?.some((p) => p.text))) return;
    s.drafts = [structuredClone(d), ...(s.drafts ?? []).filter((x) => x.id !== d.id)].slice(0, 8);
}

const ACTIONS = {
    go: (el) => {
        state.page = el.dataset.page || 'home';
        if (el.dataset.tab) state.ptab = el.dataset.tab;
        if (!state.busy) state.lastStatus = '';
        renderAll();
        const box = state.root?.closest?.('.popup-content, .popup-body, dialog');
        try { box?.scrollTo?.(0, 0); state.root?.scrollIntoView?.({ block: 'start' }); } catch { /* ignore */ }
    },
    ptab: (el) => { state.ptab = el.dataset.tab; renderAll(); },
    loadCard: () => {
        const avatar = $(state.root).find('.cw-cardsel').val();
        if (!avatar) return toastr.info('先选一张卡', '写卡工坊');
        return loadExisting(avatar);
    },
    loadAU: () => {
        const avatar = $(state.root).find('.cw-cardsel').val();
        if (!avatar) return toastr.info('先选一张卡', '写卡工坊');
        return step(async () => {
            const card = await fetchCard(avatar);
            const worldName = card.data?.extensions?.world || '';
            let worldData = null;
            if (worldName) { try { worldData = await (await worldApi()).load(worldName); } catch { worldData = null; } }
            pushHistory();
            settings().draft = flow.auStart(card, worldData, worldName);
            state.checks = null; state.bagu = null;
            state.page = 'au';
            return '先从原卡提取内核，再写 AU 设定。';
        });
    },
    backstory: (el) => {
        const p = draft().personas[Number(el.dataset.i)];
        const d = draft();
        // 人设的“哪里不满意”也用在经历上
        const fb = d.feedback?.[`persona:${p.name}`];
        if (fb) { d.feedback[`backstory:${p.name}`] = fb; d.feedback[`persona:${p.name}`] = ''; }
        return step(async () => { const st = await flow.backstory(d, p.name); return `经历写好了：${st.count} 段，${st.chars} 字（不满意可以换回上一版）。`; });
    },
    auCore: () => step(() => flow.auCore(draft()), '内核提取好了，看一下，不对就直接改。然后写 AU 设定。'),
    auMap: () => step(() => flow.auMap(draft()), '映射表写好了，逐条看一下。然后去“主要人设”生成 AU 人设。'),
    auCheck: (el) => { const p = draft().personas[Number(el.dataset.i)]; return step(() => flow.auCheck(draft(), p.name), '检查完了，结果在人设下面。'); },
    auFix: (el) => { const p = draft().personas[Number(el.dataset.i)]; return step(() => flow.auFix(draft(), p.name), '按检查结果修好了（不满意可以换回上一版）。'); },
    revise: (el) => step(() => flow.revise(draft(), el.dataset.key), '按意见改好了（不满意可以换回上一版）。'),
    suggestRoutes: () => step(() => flow.suggestRoutes(draft()), '看看哪条想要，点“加上”。'),
    addRouteIdea: (el) => { flow.addRouteIdea(draft(), Number(el.dataset.i)); saveDraft(); state.lastStatus = '加上了。点“给新路线写信息”。'; renderAll(); },
    writeBack,
    undoWriteBack,
    ideaQA: () => {
        if (!draft().idea.trim()) return toastr.info('先写一句话脑洞', '写卡工坊');
        return step(() => flow.ideaQA(draft()), '点选或自己写，然后“带上回答生成构想”。');
    },
    hooks: (el) => step(() => flow.hooks(draft(), ensureRoute(Number(el.dataset.i))), '勾选喜欢的梗，可以改字，再点“扩写”。'),
    expand: (el) => step(async () => { state.greetCleaned = 0; const n = await greetClean(() => flow.expand(draft(), ensureRoute(Number(el.dataset.i)))); return `扩写了 ${n} 个开场白，加在这条路线后面。${greetCleanNote()}`; }),
    addHook: (el) => {
        const i = ensureRoute(Number(el.dataset.i));
        const r = draft().routes[i];
        const val = $(state.root).find(`.cw-newhook[data-r="${el.dataset.i}"]`).val()?.trim();
        if (!val) return;
        draft().hooks ??= {};
        (draft().hooks[r.name] ??= []).push({ text: val, on: true, mine: true });
        saveDraft(); renderAll();
    },
    delHook: (el) => {
        const r = routeAt(Number(el.dataset.r));
        draft().hooks?.[r.name]?.splice(Number(el.dataset.h), 1);
        saveDraft(); renderAll();
    },
    editStep: () => { state.page = 'prompts'; state.ptab = 'mine'; renderAll(); },
    recompose: () => {
        const d = draft();
        flow.remember(d, 'intro', d.intro);
        d.intro.text = flow.composeIntroFor(d);
        saveDraft(); state.lastStatus = '按当前风格重新排版了（原来的可以换回上一版）。'; renderAll();
    },
    addIntroStyle: () => {
        const s = settings();
        s.introStyles.push({ name: `我的风格 ${s.introStyles.length + 1}`, tpl: DEFAULT_INTRO_STYLE });
        save(); renderAll();
    },
    delIntroStyle: (el) => {
        const s = settings();
        const i = Number(el.dataset.i);
        s.introStyles.splice(i, 1);
        if (Number(s.introStyle) === i + 1) s.introStyle = 0; else if (Number(s.introStyle) > i + 1) s.introStyle -= 1;
        save(); renderAll();
    },
    restore: (el) => {
        if (flow.restore(draft(), el.dataset.key)) { saveDraft(); state.lastStatus = '换回上一版了。再点一次会继续往前换，换一圈回到最新的。'; renderAll(); }
    },
    resetStep: () => { settings().prompts[state.editStep] = ''; save(); renderAll(); },
    resetRule: () => {
        const s = settings();
        const k = state.editRule;
        s.rules[k] = '';
        delete s.ruleOff[k]; delete s.ruleModes[k]; delete s.ruleSteps[k];
        save(); renderAll();
    },
    addRule: () => {
        const s = settings();
        const name = String($(state.root).find('.cw-newrule').val() ?? '').trim();
        if (!name) return toastr.info('先写规则的名字', '写卡工坊');
        if (/[{}.\s]/.test(name)) return toastr.warning('名字里不要有空格、点和花括号', '写卡工坊');
        if (name in DEFAULT_RULES || name in s.customRules) return toastr.warning('已经有同名的规则了', '写卡工坊');
        s.customRules[name] = '';
        s.ruleSteps[name] = [];
        state.editRule = name;
        save(); renderAll();
    },
    delRule: async () => {
        const c = getCtx();
        const s = settings();
        const k = state.editRule;
        if (k in DEFAULT_RULES) return;
        if (!(await c.callGenericPopup(`删除规则“${esc(k)}”？`, c.POPUP_TYPE.CONFIRM))) return;
        delete s.customRules[k]; delete s.ruleOff[k]; delete s.ruleModes[k]; delete s.ruleSteps[k];
        state.editRule = '通用';
        save(); renderAll();
    },
    addStep: () => {
        settings().customSteps.push({ id: `step${Date.now().toString(36)}`, name: '', stage: 'card', light: 'blue', position: 'after', keys: [], template: STEP_TEMPLATE, output: 'free', after: 'tone', auto: false });
        save(); renderAll();
    },
    delStep: (el) => { settings().customSteps.splice(Number(el.dataset.i), 1); save(); renderAll(); },
    stop: () => {
        state.abort = true;
        try { getCtx().stopGeneration?.(); } catch { /* ignore */ }
        setStatus('正在停止…');
    },
    openDraft: (el) => {
        const s = settings();
        const pick = s.drafts[Number(el.dataset.i)];
        if (!pick) return;
        pushHistory();
        s.drafts = (s.drafts ?? []).filter((x) => x.id !== pick.id);
        s.draft = structuredClone(pick);
        state.checks = null; state.bagu = null;
        saveDraft(); renderAll();
    },
    delDraft: async (el) => {
        const c = getCtx();
        const s = settings();
        const x = s.drafts[Number(el.dataset.i)];
        if (!x) return;
        if (!(await c.callGenericPopup(`删除草稿“${esc(x.name || x.idea?.slice(0, 16) || '未命名')}”？删了找不回来。`, c.POPUP_TYPE.CONFIRM))) return;
        s.drafts.splice(Number(el.dataset.i), 1);
        save(); renderAll();
    },
    delCurrent: async () => {
        const c = getCtx();
        if (!(await c.callGenericPopup('删除当前草稿？不会放进历史草稿，删了找不回来。已经导入酒馆的卡和世界书不受影响。', c.POPUP_TYPE.CONFIRM))) return;
        settings().draft = emptyDraft();
        state.checks = null; state.bagu = null; state.page = 'home'; state.lastStatus = '当前草稿已删除。';
        saveDraft(); renderAll();
    },
    clearDrafts: async () => {
        const c = getCtx();
        const s = settings();
        if (!(await c.callGenericPopup(`清空全部 ${s.drafts.length} 份历史草稿？当前草稿不动。删了找不回来。`, c.POPUP_TYPE.CONFIRM))) return;
        s.drafts = [];
        save(); renderAll();
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
    persona: (el) => step(async () => {
        const d = draft();
        const i = Number(el.dataset.i);
        const fresh = !d.personas[i]?.text?.trim();
        const others = d.personas.filter((x, k) => k !== i && x.text?.trim()).length;
        await flow.persona(d, i);
        const p = d.personas[i];
        const hints = [];
        if (fresh && others) {
            if (d.relations) hints.push('角色关系网里还没有 TA，到页面底部重写一下');
            if (d.routes.some((r) => r.info?.trim())) hints.push('路线的玩家信息里还没有 TA，可以到“玩家与路线”重写，或者用局部重写补上');
        }
        return `${esc(p.name)} 的人设写好了。${hints.length ? `<br><span class="cw-warntext">${hints.join('；')}。</span>` : ''}`;
    }),
    allPersonas: () => step(async () => { const d = draft(); for (let i = 0; i < d.personas.length; i++) { setStatus(`人设：${esc(d.personas[i].name || '新角色')}…`); await flow.persona(d, i); saveDraft(); } }, '人设都写好了。'),
    predict: (el) => { const p = draft().personas[Number(el.dataset.i)]; return step(() => flow.predict(draft(), p.name), '测试完了，结果在角色下面。'); },
    destale: (el) => { const p = draft().personas[Number(el.dataset.i)]; return step(async () => { const n = await flow.destale(draft(), p.name); return `撞车的部分重写了，改了 ${n} 处，在人设框上面“改了什么”里看。`; }); },
    world: () => step(() => flow.world(draft()), '世界观写好了。'),
    npc: () => step(() => flow.npc(draft()), 'NPC 写好了。'),
    relations: () => step(() => flow.relations(draft()), '角色关系网写好了。'),
    npcOne: (el) => step(async () => { const n = await flow.npcOne(draft(), Number(el.dataset.i)); return `${esc(n.name)} 写好了，别的 NPC 没动。`; }),
    routes: () => step(() => flow.routes(draft()), '路线信息写好了。'),
    tone: () => step(() => flow.tone(draft()), '基调与规则写好了。'),
    free: (el) => step(() => flow.free(draft(), Number(el.dataset.i)), '模块写好了。'),
    custom: (el) => { const st = settings().customSteps[Number(el.dataset.i)]; return step(() => flow.custom(draft(), st), `${esc(st.name)} 完成，产出在自由模块里。`); },
    greet: (el) => step(async () => { state.greetCleaned = 0; await greetClean(() => flow.greetings(draft(), Number(el.dataset.i))); return `开场白写好了。${greetCleanNote()}`; }),
    add: (el) => { getPath(draft(), el.dataset.path).push(TEMPLATES[el.dataset.tpl]()); saveDraft(); renderAll(); },
    del: (el) => { getPath(draft(), el.dataset.path).splice(Number(el.dataset.i), 1); saveDraft(); renderAll(); },
    localCheck: () => { state.checks = flow.localCheck(draft()); renderAll(); },
    baguScan: () => {
        const opts = baguOptions(getCtx().extensionSettings, flow.banned(draft()));
        state.bagu = flow.textSlots(draft()).filter((s) => !s.rules && !isInstructions(s.get())).map((s) => ({ s, r: baguScan(s.get(), opts) })).filter((x) => x.r.total)
            .map((x) => ({ label: x.s.label, text: `${x.r.must ? `<b class="cw-err">必改 ${x.r.must}</b> · ` : ''}八股 ${x.r.total} 处：${esc(wordsText(x.r.words, 10))}` }));
        if (!state.bagu.length) state.bagu = [{ label: '八股清理', text: '没扫到八股' }];
        renderAll();
    },
    baguFix: () => step(baguFix, '八股清理完成。'),
    localEdit: () => step(async () => {
        const d = draft();
        const sel = state.sel;
        if (!sel) throw new Error('先在框里选中要改的那段');
        const k = keyOfPath(d, sel.path) ?? {};
        const r = await flow.localEdit(d, { ...sel, instruction: state.selNote ?? '', key: k.key, label: k.label });
        state.sel = null;
        state.selNote = '';
        return `改好了这一段（${[...r.before.trim()].length} 字 → ${[...r.after.trim()].length} 字）。${k.key ? '原来的和现在的在这一块上面“改了什么”里看，不满意点“换回上一版”。' : ''}`;
    }),
    addStyle: () => { settings().styles.push({ name: `文风 ${settings().styles.length + 1}`, text: '' }); save(); renderAll(); },
    delStyle: (el) => { const i = Number(el.dataset.i); settings().styles.splice(i, 1); const d = draft(); if (Number(d.style) === i + 1) d.style = 0; else if (Number(d.style) > i + 1) d.style -= 1; save(); saveDraft(); renderAll(); },
    playStart: () => { const d = draft(); flow.playStart(d, Number(d.play?.greet ?? 0)); saveDraft(); renderAll(); },
    playSend: () => step(async () => {
        const d = draft();
        const text = String(d.play?.input ?? '').trim();
        if (text) { d.play.messages.push({ role: 'user', text }); d.play.input = ''; }
        await flow.playChar(d);
    }, ''),
    playUserOnce: () => step(() => flow.playUser(draft(), { send: false }), 'AI 写的 user 在输入框里，可以改了再发送。'),
    playAuto: () => step(async () => { const n = await flow.playAuto(draft(), draft().play?.rounds ?? 3); return `跑了 ${n} 轮。`; }),
    playRedo: () => step(() => flow.playRedo(draft()), ''),
    playCut: (el) => { const d = draft(); d.play.messages.splice(Math.max(1, Number(el.dataset.i))); d.play.review = null; saveDraft(); renderAll(); },
    playReview: () => step(() => flow.playReview(draft()), '点评好了。'),
    playFix: (el) => {
        const d = draft();
        const issue = d.play?.review?.issues?.[Number(el.dataset.i)];
        if (!issue) return;
        const t = flow.reviewTarget(d, issue);
        d.feedback ??= {};
        const add = [issue.problem && `试玩发现：${issue.problem}`, issue.fix].filter(Boolean).join('；');
        d.feedback[t.key] = [d.feedback[t.key], add].filter((x) => String(x ?? '').trim()).join('\n');
        saveDraft();
        state.page = t.page;
        renderAll();
        toastr.info('意见已经填进“哪里不满意”框里，点重写或按意见改', '写卡工坊');
    },
    baguPage: (el) => step(() => baguPage(el.dataset.page)),
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
        const bind = this.dataset.bind;
        const $tok = $root.find('.cw-tok[data-tok-path]').filter((_, el) => el.dataset.tokPath === bind);
        if ($tok.length) {
            $tok.text(tokText([this.value], { exact: false }));
            clearTimeout(state.tokTimer);
            state.tokTimer = setTimeout(refreshTokens, 800);
        }
        saveDraft();
    });
    $root.on('select keyup mouseup touchend', 'textarea[data-bind]', function () { const el = this; setTimeout(() => updateSelBar(el), 0); });
    // 手机上长按选字不一定触发 select，再听一下 selectionchange
    if (!state.selListen) {
        state.selListen = true;
        let t = null;
        document.addEventListener('selectionchange', () => {
            const el = document.activeElement;
            if (!el?.matches?.('textarea[data-bind]') || !state.root?.contains(el)) return;
            clearTimeout(t);
            t = setTimeout(() => updateSelBar(el), 150);
        });
    }
    $root.on('input', 'textarea[data-bind]', function () { $(this).nextAll('.cw-selbar').first().remove(); });
    $root.on('input', '.cw-selin', function () { state.selNote = this.value; });
    $root.on('change', 'select[data-bind="mode"]', () => setTimeout(renderAll, 0));
    $root.on('change', '.cw-stylesel', function () { draft().style = Number(this.value) || 0; saveDraft(); renderAll(); });
    $root.on('change', '.cw-styleall', function () { draft().styleAll = this.checked; saveDraft(); });
    $root.on('input', '.cw-stname', function () { const x = settings().styles[Number(this.dataset.i)]; if (x) { x.name = this.value; save(); } });
    $root.on('input', '.cw-sttext', function () { const x = settings().styles[Number(this.dataset.i)]; if (x) { x.text = this.value; save(); } });
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
    $root.on('input', '.cw-rule-ta', function () {
        const k = state.editRule;
        if (k in DEFAULT_RULES) S().rules[k] = this.value.trim() === DEFAULT_RULES[k].trim() ? '' : this.value;
        else S().customRules[k] = this.value;
        save();
    });
    $root.on('change', '.cw-rule-on', function () { S().ruleOff[state.editRule] = !this.checked; if (this.checked) delete S().ruleOff[state.editRule]; save(); renderAll(); });
    $root.on('change', '.cw-rule-mode', function () { S().ruleModes[state.editRule] = this.value; save(); renderAll(); });
    $root.on('change', '.cw-rulestep', function () {
        const r = flow.ruleList().find((x) => x.name === state.editRule);
        const set = new Set(r?.steps ?? []);
        if (this.checked) set.add(this.dataset.step); else set.delete(this.dataset.step);
        S().ruleSteps[state.editRule] = [...set];
        save(); renderAll();
    });
    $root.on('change', '.cw-pageon', function () {
        const off = new Set(S().offPages ?? []);
        if (this.checked) off.delete(this.dataset.page); else off.add(this.dataset.page);
        S().offPages = [...off];
        save(); renderAll();
    });
    $root.on('change', '.cw-dim-sel', function () { state.editDim = this.value; renderAll(); });
    $root.on('input', '.cw-dim-ta', function () { S().customTags[state.editDim] = this.value.split('\n').map((x) => x.trim()).filter(Boolean); save(); });
    $root.on('input change', '[data-step]', function () {
        const st = S().customSteps[Number(this.dataset.step)];
        if (!st) return;
        const k = this.dataset.key;
        st[k] = k === 'keys' ? this.value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) : k === 'auto' ? this.checked : this.value;
        save();
    });
    $root.on('change', '.cw-exen', function () {
        const e = draft().existing?.entries?.[Number(this.dataset.i)];
        if (e) { e.disable = !this.checked; saveDraft(); }
    });
    $root.on('input', '.cw-cardfilter', function () {
        const q = this.value.trim().toLowerCase();
        $root.find('.cw-cardsel option').each((_, o) => { o.hidden = !!q && !o.textContent.toLowerCase().includes(q); });
    });
    $root.on('dblclick', '.cw-cardsel option', () => ACTIONS.loadCard());
    $root.on('change', '.cw-hookcheck', function () {
        const h = draft().hooks?.[routeAt(Number(this.dataset.r)).name]?.[Number(this.dataset.h)];
        if (h) { h.on = this.checked; saveDraft(); renderAll(); }
    });
    $root.on('input', '.cw-hooktext', function () {
        const h = draft().hooks?.[routeAt(Number(this.dataset.r)).name]?.[Number(this.dataset.h)];
        if (h) { h.text = this.value; saveDraft(); }
    });
    $root.on('keydown', '.cw-newhook', function (e) { if (e.key === 'Enter') ACTIONS.addHook({ dataset: { i: this.dataset.r } }); });
    $root.on('change', '.cw-introstyle', function () {
        S().introStyle = Number(this.value) || 0;
        save();
        const d = draft();
        if (d.intro?.parts && Object.keys(d.intro.parts).length) {
            flow.remember(d, 'intro', d.intro);
            d.intro.text = flow.composeIntroFor(d);
            saveDraft();
            state.lastStatus = '换了风格，重新排版了（原来的可以换回上一版）。';
        }
        renderAll();
    });
    $root.on('input', '.cw-isname', function () { const x = S().introStyles[Number(this.dataset.i)]; if (x) { x.name = this.value; save(); } });
    $root.on('input', '.cw-istpl', function () { const x = S().introStyles[Number(this.dataset.i)]; if (x) { x.tpl = this.value; save(); } });
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
<label class="checkbox_label"><input type="checkbox" data-set="autoBackstory" ${s.autoBackstory ? 'checked' : ''}>一键出卡时，经历太少（不到 3 段或太短）就单独展开经历（每个角色多 1 次调用）</label>
<label>经历写几段<input class="text_pole cw-num" data-set="backstoryCount" value="${esc(s.backstoryCount)}"></label>
<label class="checkbox_label"><input type="checkbox" data-set="autoPredict" ${s.autoPredict ? 'checked' : ''}>一键出卡时做可预测性测试，撞车就自动重写（每个角色多 2–3 次调用）</label>
<label class="checkbox_label"><input type="checkbox" data-set="autoBagu" ${s.autoBagu ? 'checked' : ''}>一键出卡时用八股清理改写</label>
<label class="checkbox_label"><input type="checkbox" data-set="greetMustClean" ${s.greetMustClean ? 'checked' : ''}>开场白一写完，带禁用词和“我的八股词”的句子立刻改掉（只改这几句，所有新开场白合在一起，通常 1–2 次调用）</label>
<label>常驻设定 token 上限<input class="text_pole cw-num" type="number" min="0" step="500" data-set="blueBudget" data-num value="${s.blueBudget}"></label>
<div class="cw-dim cw-small">蓝灯条目 + 当前路线 + 角色描述加起来超过这个数，目录和导入页会标出来。0 = 不提示。用酒馆当前 API 的分词器算，算不了时按字数估。</div>

<div class="cw-sub">试玩</div>
<label>角色每次回复大约多少字<input class="text_pole cw-num" type="number" min="50" step="50" data-set="playLength" data-num value="${s.playLength}"></label>

<div class="cw-sub">简介</div>
<label>作者<input class="text_pole cw-in" data-set="author" value="${esc(s.author)}"></label>
<label>二传<input class="text_pole cw-in" data-set="license.repost" value="${esc(s.license.repost)}"></label>
<label>二改<input class="text_pole cw-in" data-set="license.edit" value="${esc(s.license.edit)}"></label>
<label>商用<input class="text_pole cw-in" data-set="license.commercial" value="${esc(s.license.commercial)}"></label>
<label>预设参考<input class="text_pole cw-in" data-set="presetNote" value="${esc(s.presetNote)}" placeholder="空着就写开场白预设的名字"></label>
<label>其他说明<input class="text_pole cw-in" data-set="introNotes" value="${esc(s.introNotes)}"></label>
<label>额外致谢<small class="cw-dim">每行一条，会加在简介的致谢里</small><textarea class="text_pole cw-in" rows="3" data-set="introThanks" placeholder="感谢某某老师的预设">${esc(s.introThanks)}</textarea></label>
<div class="cw-dim cw-small">简介的致谢里一定会写“${esc(CREDIT_WORKSHOP)}”；人设模板没改过时还会写“感谢灰鸠老师的人设模板”，在规则库里改了或关掉人设模板就自动去掉。</div>
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
