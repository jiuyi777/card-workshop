// 提示词工坊 v0.1.0 · SillyTavern 客户端扩展
import { MODULE, BUILTIN_ANCHORS, WRITE_MODES, clone, defaultPreset, makeEntry,
  newAssembly, emptyState, sanitizeState, currentAssembly, ensureAssemblyTracks,
  importEntries, isNativePreset, buildPreset, validatePreset, tagsOf, newId } from './src/core.js';
import { listProfiles, listPresets, getCurrentPreset, writePrompt } from './src/llm.js';

const ctx = () => SillyTavern.getContext();
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const option = (v, label, current) => `<option value="${esc(v)}" ${String(v) === String(current) ? 'selected' : ''}>${esc(label)}</option>`;
let state = null;
let root = null;
let page = 'write';
let libraryQuery = '';
let libraryTag = '';
let statusText = '';
let busy = false;
let controller = null;
let dragged = null;
let importedSelection = [];

const notify = (msg, bad = false) => {
  statusText = msg;
  if (bad) console.error('[提示词工坊]', msg);
  (bad ? globalThis.toastr?.error : globalThis.toastr?.success)?.(msg);
  const el = root?.querySelector('.pw-status'); if (el) el.textContent = msg;
};
function save() {
  const c = ctx();
  c.extensionSettings ||= {};
  c.extensionSettings[MODULE] = state;
  c.saveSettingsDebounced?.();
}
function readState() {
  const c = ctx();
  c.extensionSettings ||= {};
  state = sanitizeState(c.extensionSettings[MODULE]);
  ensureAssemblyTracks(state, state.entries, false);
  save();
}
function btn(act, label, cls = '', extra = '') {
  return `<button type="button" class="pw-btn ${cls}" data-action="${act}" ${extra}>${label}</button>`;
}
function labelInput(label, html, hint = '') {
  return `<label class="pw-field"><span class="pw-field-label">${label}</span>${html}${hint ? `<small>${hint}</small>` : ''}</label>`;
}
const dInput = (key, ph = '', type = 'text') => `<input class="pw-input" type="${type}" data-draft="${key}" placeholder="${esc(ph)}" value="${esc(state.draft[key])}">`;
const dSelect = (key, opts) => `<select class="pw-input" data-draft="${key}">${opts.map(([v, l]) => option(v, l, state.draft[key])).join('')}</select>`;

function writePage() {
  const d = state.draft;
  return `<div class="pw-pagehead"><div><div class="pw-eyebrow">01 / CREATE</div><h2>写一个提示词</h2><p>把想法变成一条能独立使用的规则。生成后可以手改，再存进条目库。</p></div>${btn('newDraft','＋ 新条目')}</div>
  <div class="pw-grid pw-grid-wide"><section class="pw-card pw-writeleft">
    ${labelInput('条目名称', dInput('name', '例如：叙事节奏 / 动态推进'))}
    <div class="pw-grid pw-grid-two">${labelInput('写作方式', dSelect('mode', Object.entries(WRITE_MODES).map(([k,v])=>[k,v.label])))}
    ${labelInput('消息角色', dSelect('role', [['system','system'],['user','user'],['assistant','assistant']]))}</div>
    ${labelInput('告诉 AI 你想写什么', `<textarea class="pw-input pw-large" data-draft="request" placeholder="写清想解决的问题、想保留的特点、具体禁忌。越具体越容易写成可执行规则。">${esc(d.request)}</textarea>`)}
    <div class="pw-row pw-inlineactions">${btn('generate', busy ? '生成中…' : (d.content ? '按需求修改' : 'AI 生成条目'), 'pw-primary', busy ? 'disabled' : '')}${btn('stop','停止','',busy ? '' : 'disabled')}
    <span class="pw-status">${esc(statusText)}</span></div>
    <details class="pw-details"><summary>写作逻辑</summary><p>默认要求 AI 输出可执行的规则、优先级和判定标准；避免大段抽象描述。不自动改动酒馆的任何预设。</p></details>
  </section>
  <section class="pw-card pw-writeright">
    <div class="pw-sectiontop"><h3>条目正文</h3><span class="pw-muted">${d.content.length.toLocaleString()} 字符</span></div>
    <textarea class="pw-input pw-result" data-draft="content" placeholder="这里会出现 AI 写好的提示词，也可以直接手动粘贴。">${esc(d.content)}</textarea>
    <div class="pw-grid pw-grid-two">${labelInput('注入位置', dSelect('anchor', BUILTIN_ANCHORS.map(x=>[x.key,x.label])))}${labelInput('深度 D（仅聊天内）', dInput('depth','0','number'))}</div>
    <div class="pw-grid pw-grid-two">${labelInput('同深度顺序', dInput('injectionOrder','100','number'))}${labelInput('标签（逗号分隔）', dInput('tags','文风，破限，格式…'))}</div>
    <div class="pw-row pw-justifyend">${btn('saveDraft', d.editId ? '保存修改' : '存入条目库','pw-primary')}${btn('copyDraft','复制正文')}</div>
  </section></div>`;
}

function libraryPage() {
  const tags = [...new Set(state.entries.flatMap(x=>x.tags))].sort((a,b)=>a.localeCompare(b,'zh'));
  const lower = libraryQuery.toLocaleLowerCase();
  const filtered = state.entries.filter(x=>(!libraryTag || x.tags.includes(libraryTag)) && (!lower || (x.name+' '+x.content+' '+x.tags.join(' ')).toLocaleLowerCase().includes(lower)));
  return `<div class="pw-pagehead"><div><div class="pw-eyebrow">02 / LIBRARY</div><h2>条目库 <span class="pw-badge">${state.entries.length}</span></h2><p>条目独立保存；可以跨方案复用，不会因为换预设而消失。</p></div>${btn('newDraft','＋ 写条目','pw-primary')}</div>
  <div class="pw-card"><div class="pw-row pw-librarybar"><input id="pw-search" class="pw-input pw-search" placeholder="搜索名称 / 正文 / 标签" value="${esc(libraryQuery)}">
  <select id="pw-tag-filter" class="pw-input">${option('','全部标签',libraryTag)}${tags.map(t=>option(t,t,libraryTag)).join('')}</select>
  ${btn('importCurrent','从当前预设导入')}${btn('importFile','从 JSON 导入')}</div></div>
  <div class="pw-list">${filtered.length ? filtered.map(x=>{
    const on = state.assemblies.filter(a=>a.selected[x.id]).length;
    return `<div class="pw-card pw-entry" data-id="${esc(x.id)}"><div class="pw-entryhead"><div><strong>${esc(x.name)}</strong><div class="pw-meta">${esc(x.role)} · ${esc(BUILTIN_ANCHORS.find(a=>a.key===x.anchor)?.label||x.anchor)} ${x.anchor==='inChat' ? `D${x.depth}`:''} · ${on} 个方案使用</div></div><div class="pw-row">${btn('editEntry','编辑','',`data-id="${esc(x.id)}"`)}${btn('addToAssembly','加入当前方案','',`data-id="${esc(x.id)}"`)}${btn('deleteEntry','删除','pw-danger-ghost',`data-id="${esc(x.id)}"`)}</div></div>
    <div class="pw-entrypreview">${esc(x.content.slice(0,320))}${x.content.length>320?'…':''}</div><div class="pw-tags">${x.tags.map(t=>`<span class="pw-tag">${esc(t)}</span>`).join('')}</div></div>`;}).join('') : '<div class="pw-empty">没有符合条件的条目。</div>'}</div>`;
}

function assemblyPage() {
  const a = currentAssembly(state);
  const byId = new Map(state.entries.map(x=>[x.id,x]));
  const list = a.order.map(id=>byId.get(id)).filter(Boolean);
  const count = list.filter(x=>a.selected[x.id]).length;
  const base = state.basePreset ? `文件底稿：${state.baseName||'未命名'}` : (getCurrentPreset()?.name ? `酒馆当前预设：${getCurrentPreset().name}` : '酒馆基础底稿');
  return `<div class="pw-pagehead"><div><div class="pw-eyebrow">03 / ASSEMBLE</div><h2>拼装预设</h2><p>勾选使用的条目，拖拽调整顺序。系统标记与角色资料由底稿保留。</p></div>
  <div class="pw-row">${btn('newAssembly','＋ 新方案')}${btn('cloneAssembly','复制方案')}${btn('deleteAssembly','删除方案','pw-danger-ghost')}</div></div>
  <div class="pw-card"><div class="pw-row pw-assemblytop"><select id="pw-assembly-select" class="pw-input pw-grow">${state.assemblies.map(x=>option(x.id,x.name,x.id===a.id?a.id:'')).join('')}</select>
  ${btn('renameAssembly','重命名')}${btn('selectAll','全选')}${btn('selectNone','全不选')}</div>
  <div class="pw-hint">已选择 ${count} / ${state.entries.length} 条 · 当前底稿：${esc(base)}</div></div>
  <div class="pw-assemblylist">${list.length ? list.map(x=>`<div class="pw-card pw-sortrow ${a.selected[x.id] ? 'pw-selected' : ''}" data-id="${esc(x.id)}" draggable="true">
  <span class="pw-grip" title="拖动排序">⠿</span><input class="pw-checkbox" type="checkbox" data-toggle-pick="${esc(x.id)}" ${a.selected[x.id] ? 'checked':''}>
  <div class="pw-rowbody"><div><strong>${esc(x.name)}</strong><div class="pw-meta">${esc(x.role)} · ${esc(BUILTIN_ANCHORS.find(v=>v.key===x.anchor)?.label||x.anchor)}${x.anchor==='inChat' ? ` · D${x.depth}` : ''}</div></div>
  <div class="pw-row pw-sortcontrols"><label title="在这个方案里启用"><input type="checkbox" data-toggle-enable="${esc(x.id)}" ${a.enabled[x.id]!==false ? 'checked':''}> 启用</label>
  ${btn('moveUp','↑','pw-compact',`data-id="${esc(x.id)}"`)}${btn('moveDown','↓','pw-compact',`data-id="${esc(x.id)}"`)}${btn('editEntry','编辑','pw-compact',`data-id="${esc(x.id)}"`)}</div></div></div>`).join('') : '<div class="pw-empty">先去「创作」存一条提示词，或从预设导入条目。</div>'}</div>
  <div class="pw-card pw-export"><h3>导出 / 应用</h3><p>导出是酒馆对话补全原生 JSON（<code>prompts</code> + <code>prompt_order</code>），不依赖本插件运行。底稿中的连接参数也会随之保留，请勿公开分享包含密钥的文件。</p>
  <div class="pw-row pw-wrap">${btn('exportPreset','⬇ 导出原生预设 JSON','pw-primary')}${btn('saveAsPreset','另存为酒馆新预设')}${btn('applyCurrent','覆盖当前预设','pw-danger-ghost')}</div>
  <details class="pw-details"><summary>查看构建结果与顺序</summary><div class="pw-preview" id="pw-build-preview">${presetPreview()}</div></details>
  </div>`;
}

function presetBase() {
  return state.basePreset || (getCurrentPreset()?.preset && isNativePreset(getCurrentPreset()?.preset) ? getCurrentPreset().preset : null) || defaultPreset();
}
function assembled() { return buildPreset(state, presetBase(), { name: currentAssembly(state).name }); }
function presetPreview() {
  try {
    const p = assembled();
    const byId = new Map(p.prompts.map(x=>[x.identifier,x]));
    const group = p.prompt_order.find(x=>String(x.character_id)==='100001') || p.prompt_order[0];
    return (group?.order || []).map((x,i)=>`${String(i+1).padStart(2,'0')} ${x.enabled?'✓':'○'} ${esc(byId.get(x.identifier)?.name||x.identifier)}${byId.get(x.identifier)?.injection_position===1?' [D'+byId.get(x.identifier).injection_depth+']':''}`).join('<br>');
  } catch (e) { return esc(e.message); }
}

function settingsPage() {
  const profiles = listProfiles();
  const presets = listPresets().map(x=>typeof x==='string'?x:x.name).filter(Boolean);
  return `<div class="pw-pagehead"><div><div class="pw-eyebrow">04 / SETTINGS</div><h2>设置与备份</h2><p>沿用酒馆连接，不需要在插件里另填 API 密钥。</p></div></div>
  <div class="pw-grid pw-grid-two"><div class="pw-card"><h3>生成设置</h3>
  ${labelInput('使用的连接配置文件', `<select class="pw-input" data-setting="apiProfile">${option('','酒馆当前连接',state.apiProfile)}${profiles.map(x=>option(x.id,x.name,state.apiProfile)).join('')}</select>`)}
  ${labelInput('写作用预设（可选）', `<select class="pw-input" data-setting="writingPreset">${option('','不额外发送预设条目',state.writingPreset)}${presets.map(x=>option(x,x,state.writingPreset)).join('')}</select>`, '选中后，AI 调用时会叠加该预设中已启用的非标记条目。')}
  ${labelInput('两次 API 请求间隔（秒）', `<input class="pw-input" type="number" min="0" max="60" data-setting="minInterval" value="${esc(state.minInterval)}">`)}
  ${labelInput('最大回复 token（0 为酒馆默认）', `<input class="pw-input" type="number" min="0" data-setting="maxTokens" value="${esc(state.maxTokens)}">`)}
  <div class="pw-hint">生成结果只放在「创作」页面，点击“存入条目库”后才会加入库，不会直接注入聊天。</div></div>
  <div class="pw-card"><h3>预设底稿</h3>
  <p>默认复制酒馆当前选中的聊天补全预设，保留模型参数、角色信息标记、世界书与聊天记录位置。</p>
  <div class="pw-hint">${esc(state.basePreset ? '固定底稿：'+(state.baseName||'导入的预设') : '动态底稿：当前酒馆预设（没有时使用兼容基础模板）')}</div>
  <div class="pw-row pw-wrap">${btn('setCurrentBase','固定当前预设为底稿')}${btn('loadBaseFile','导入底稿 JSON')}${btn('clearBase','恢复动态底稿')}</div>
  <hr class="pw-rule"><h3>条目库备份</h3><p>备份包含条目、标签、拼装方案和草稿。若固定底稿里有代理密码或自定义请求头，备份也可能包含这些字段，请自行保管。</p>
  <div class="pw-row pw-wrap">${btn('exportLibrary','导出工坊备份')}${btn('importLibrary','导入工坊备份')}</div>
  <hr class="pw-rule"><h3>兼容说明</h3><p>仅支持 SillyTavern「聊天补全 / Chat Completion」原生预设格式。文本补全（Instruct / Context）结构不同，不能直接当成 <code>prompts</code> 预设应用。</p></div></div>`;
}

function render() {
  if (!root) return;
  const tabs = [['write','创作'],['library','条目库'],['assembly','拼装'],['settings','设置']];
  root.innerHTML = `<div class="pw-backdrop" data-action="close"></div><div class="pw-shell" role="dialog" aria-modal="true" aria-label="提示词工坊">
    <header class="pw-header"><div class="pw-brand"><div class="pw-logo">✦</div><div><strong>提示词工坊</strong><small>PROMPT WORKSHOP · 0.1.0</small></div></div>
    <nav class="pw-tabs">${tabs.map(([k,n])=>`<button type="button" data-action="tab" data-page="${k}" class="pw-tab ${k===page?'active':''}">${n}</button>`).join('')}</nav>
    <button type="button" class="pw-close" data-action="close" aria-label="关闭">✕</button></header>
    <main class="pw-main">${({write:writePage,library:libraryPage,assembly:assemblyPage,settings:settingsPage})[page]()}</main>
    <footer class="pw-footer"><span>✦ 模块化写作 · 条目独立复用</span><span>数据存于酒馆扩展设置中</span></footer>
  </div>`;
  const focus = root.querySelector('input[data-draft="name"]');
  if (page==='write' && !state.draft.name && !busy) focus?.focus();
}
function open() {
  if (!state) readState();
  if (!root) {
    root=document.createElement('div');root.id='prompt-workshop-root'; document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('drop', onDrop);
    root.addEventListener('dragend',onDragEnd);
  }
  root.style.display = 'block'; document.body.classList.add('pw-open'); render();
}
function close() { if(root) root.style.display='none';document.body.classList.remove('pw-open'); }

function onInput(e) {
  if (e.target.dataset.draft) {
    const key = e.target.dataset.draft;
    state.draft[key] = e.target.value;
    save();
    if (key==='content') root.querySelector('.pw-writeright .pw-muted').textContent = `${e.target.value.length.toLocaleString()} 字符`;
  }
  if (e.target.id==='pw-search') {
    const pos = e.target.selectionStart;
    libraryQuery=e.target.value; render();
    const input = root.querySelector('#pw-search'); input?.focus();input?.setSelectionRange(pos,pos);
  }
}
function onChange(e) {
  const el=e.target;
  if (el.dataset.setting) { state[el.dataset.setting] = el.type==='number'?Number(el.value):el.value;save(); }
  if (el.dataset.draft) { state.draft[el.dataset.draft]=el.value;save(); if (['mode','anchor','role'].includes(el.dataset.draft)) render(); }
  if (el.id==='pw-tag-filter') {libraryTag=el.value;render();}
  if (el.id==='pw-assembly-select') {state.activeAssembly=el.value;save();render();}
  const a=currentAssembly(state);
  if (el.dataset.togglePick) {a.selected[el.dataset.togglePick]=el.checked;save();render();}
  if (el.dataset.toggleEnable) {a.enabled[el.dataset.toggleEnable]=el.checked;save();render();}
}

function freshDraft() {
  state.draft = emptyState().draft;
  page='write';save();render();
}
function editEntry(id) {
  const x=state.entries.find(x=>x.id===id);
  if(!x)return;
  state.draft={ editId:x.id, name:x.name, mode:x.tags.includes('文风')?'style':x.tags.includes('规则')?'rule':'module', role:x.role,
    anchor:x.anchor, depth:x.depth, injectionOrder:x.injectionOrder, tags:x.tags.join('，'),request:'',content:x.content };
  page='write';save();render();
}
function storeDraft() {
  const d=state.draft;
  if(!d.name?.trim() || !d.content?.trim()) return notify('条目名称和正文不能为空。',true);
  let current=state.entries.find(x=>x.id===d.editId);
  const item=makeEntry({ ...current, name:d.name, content:d.content, role:d.role, anchor:d.anchor, depth:d.depth,
    injectionOrder:d.injectionOrder, tags:tagsOf(d.tags), id:current?.id||newId(), created:current?.created });
  if (current) state.entries[state.entries.indexOf(current)] = item;
  else {state.entries.push(item);ensureAssemblyTracks(state,[item],false);}
  d.editId=item.id;
  save();notify(`已保存：${item.name}`);render();
}
function downloadJson(value, name) {
  const blob = new Blob([JSON.stringify(value,null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name.replace(/[\\/:*?"<>|]/g,'_')+'.json';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),3000);
}
function pickJson() {
  return new Promise((resolve,reject)=>{
    const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
    input.style.display='none';document.body.appendChild(input);
    input.onchange=async()=>{
      try { if(!input.files?.[0]) return resolve(null);const text=await input.files[0].text();resolve({data:JSON.parse(text),name:input.files[0].name}); }
      catch(e){reject(new Error('JSON 解析失败：'+e.message));}
      finally {input.remove();}
    };
    input.click();
  });
}
function confirmAction(message) { return window.confirm(message); }
function move(id, dir) {
  const a=currentAssembly(state);const i=a.order.indexOf(id);const j=i+dir;
  if(i<0||j<0||j>=a.order.length)return;
  [a.order[i],a.order[j]]=[a.order[j],a.order[i]];save();render();
}
function nativeImport(p, name) {
  if (!isNativePreset(p))throw new Error('需要聊天补全原生预设（prompts + prompt_order）。');
  const entries=importEntries(p,state.entries);
  state.entries.push(...entries);
  ensureAssemblyTracks(state,entries,false);
  save();render();notify(`从「${name}」导入 ${entries.length} 个正文条目，默认未勾选。`);
}
async function onClick(e) {
  const target=e.target.closest('[data-action]');if(!target)return;
  const act=target.dataset.action,id=target.dataset.id;
  if(act==='close'){close();return;}
  if(act==='tab'){page=target.dataset.page;statusText='';render();return;}
  try {
    switch(act) {
      case 'newDraft': freshDraft(); break;
      case 'copyDraft': await navigator.clipboard.writeText(state.draft.content);notify('已复制正文');break;
      case 'saveDraft': storeDraft();break;
      case 'generate':{
        if(busy)return;
        busy=true;controller=new AbortController();
        const snapshot=clone(state.draft); render();
        try {
          const text=await writePrompt({draft:snapshot,settings:state,onStatus:s=>{statusText=s;const n=root.querySelector('.pw-status');if(n)n.textContent=s;},abortSignal:controller.signal});
          state.draft.content=text;save();notify('提示词已生成，可以手动修改后保存。');
        }catch(err){notify(err.message,true);}
        finally{busy=false;controller=null;render();}
        break;}
      case 'stop':controller?.abort();break;
      case 'editEntry':editEntry(id);break;
      case 'deleteEntry':{
        const x=state.entries.find(v=>v.id===id);if(!x||!confirmAction(`永久删除条目「${x.name}」？它也会从所有拼装方案中消失。`))break;
        state.entries=state.entries.filter(v=>v.id!==id);
        for(const a of state.assemblies){a.order=a.order.filter(v=>v!==id);delete a.selected[id];delete a.enabled[id];}
        if(state.draft.editId===id)state.draft.editId='';save();render();break;}
      case 'addToAssembly':{
        const a=currentAssembly(state);a.selected[id]=true;save();page='assembly';render();notify('已加入当前方案');break;}
      case 'importCurrent':{
        const r=getCurrentPreset();if(!r?.preset)throw new Error('当前没有可读取的对话补全预设。');nativeImport(r.preset,r.name);break;}
      case 'importFile':{
        const res=await pickJson();if(res)nativeImport(res.data,res.name);break;}
      case 'newAssembly':{
        const name=prompt('新方案名称','新预设');if(!name?.trim())break;
        const a=newAssembly(name.trim());a.order=state.entries.map(x=>x.id);state.assemblies.push(a);state.activeAssembly=a.id;save();render();break;}
      case 'renameAssembly':{
        const a=currentAssembly(state);const name=prompt('重命名方案',a.name);if(!name?.trim())break;a.name=name.trim();save();render();break;}
      case 'cloneAssembly':{
        const a=clone(currentAssembly(state));a.id=newId();a.name+=' · 副本';state.assemblies.push(a);state.activeAssembly=a.id;save();render();break;}
      case 'deleteAssembly':{
        if(state.assemblies.length<=1)throw new Error('至少保留一个方案。');
        const a=currentAssembly(state);if(!confirmAction(`删除方案「${a.name}」？条目库不受影响。`))break;
        state.assemblies=state.assemblies.filter(x=>x.id!==a.id);state.activeAssembly=state.assemblies[0].id;save();render();break;}
      case 'selectAll':case 'selectNone':{
        const a=currentAssembly(state);for(const x of state.entries)a.selected[x.id]=act==='selectAll';save();render();break;}
      case 'moveUp':move(id,-1);break;
      case 'moveDown':move(id,1);break;
      case 'exportPreset':{
        const p=assembled();const errors=validatePreset(p);if(errors.length)throw new Error(errors.join('；'));
        downloadJson(p,currentAssembly(state).name);notify('已导出酒馆原生预设 JSON');break;}
      case 'saveAsPreset':{
        const pm=ctx().getPresetManager?.('openai');if(!pm?.savePreset)throw new Error('当前酒馆没有可用的聊天补全预设管理器。');
        const name=prompt('保存为新的酒馆预设名称',currentAssembly(state).name);if(!name?.trim())break;
        const p=buildPreset(state,presetBase(),{name:name.trim()});
        const errors=validatePreset(p);if(errors.length)throw new Error(errors.join('；'));
        const names=pm.getAllPresets?.()||[];
        if(names.some(x=>(typeof x==='string'?x:x.name)===name.trim()) && !confirmAction('这个名称已经存在，将覆盖同名预设。确定吗？'))break;
        await pm.savePreset(name.trim(),p);notify(`已保存酒馆预设「${name.trim()}」；可在预设下拉框中选择。`);break;}
      case 'applyCurrent':{
        const pm=ctx().getPresetManager?.('openai');const current=getCurrentPreset();
        if(!pm?.savePreset||!current?.name||!current?.preset)throw new Error('没有当前选中的聊天补全预设。');
        if(!confirmAction(`即将覆盖酒馆当前预设「${current.name}」。\n会先下载一份原始 JSON 备份。确认覆盖吗？`))break;
        downloadJson(current.preset,current.name+'-修改前备份');
        const p=buildPreset(state,current.preset,{name:current.name});
        const errors=validatePreset(p);if(errors.length)throw new Error(errors.join('；'));
        await pm.savePreset(current.name,p);
        const key=pm.findPreset?.(current.name);
        if(key!==undefined&&key!==null)pm.selectPreset?.(key);
        notify(`已写入当前预设「${current.name}」，原版 JSON 已备份。`);break;}
      case 'setCurrentBase':{
        const r=getCurrentPreset();if(!r?.preset||!isNativePreset(r.preset))throw new Error('当前不是聊天补全预设。');
        state.basePreset=clone(r.preset);state.baseName=r.name;save();render();notify('已保存当前预设为固定底稿。');break;}
      case 'loadBaseFile':{
        const r=await pickJson();if(!r)break;if(!isNativePreset(r.data))throw new Error('底稿不是聊天补全预设。');
        state.basePreset=clone(r.data.data?.prompts?r.data.data:r.data);state.baseName=r.name;save();render();notify('已导入底稿。');break;}
      case 'clearBase':state.basePreset=null;state.baseName='';save();render();break;
      case 'exportLibrary':{
        const backup={format:'prompt-workshop-library',version:1,exportedAt:new Date().toISOString(),data:clone(state)};
        downloadJson(backup,'提示词工坊-条目库备份');notify('已导出备份。');break;}
      case 'importLibrary':{
        const r=await pickJson();if(!r)break;
        if(r.data?.format!=='prompt-workshop-library'||!r.data?.data)throw new Error('不是提示词工坊备份文件。');
        if(!confirmAction('导入备份将替换当前条目库与拼装方案。请先导出现有备份。继续吗？'))break;
        state=sanitizeState(r.data.data);ensureAssemblyTracks(state,state.entries,false);save();render();notify('备份已恢复。');break;}
    }
  }catch(err){notify(err?.message||String(err),true);}
}
function onDragStart(e) {
  const row=e.target.closest('.pw-sortrow');if(!row)return;
  dragged=row.dataset.id;row.classList.add('pw-dragging');
  if(e.dataTransfer){e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',dragged);}
}
function onDragOver(e) {const row=e.target.closest('.pw-sortrow');if(!row||!dragged)return;e.preventDefault();e.dataTransfer.dropEffect='move';}
function onDrop(e) {
  const row=e.target.closest('.pw-sortrow');if(!row||!dragged)return;e.preventDefault();
  const a=currentAssembly(state);const from=a.order.indexOf(dragged),to=a.order.indexOf(row.dataset.id);
  if(from>=0&&to>=0&&from!==to){a.order.splice(from,1);a.order.splice(to,0,dragged);save();render();}
  dragged=null;
}
function onDragEnd(){dragged=null;root?.querySelectorAll('.pw-dragging').forEach(x=>x.classList.remove('pw-dragging'));}

function initMenu() {
  if(document.getElementById('pw-launch'))return;
  const menu=document.querySelector('#extensionsMenu');
  const trigger=document.createElement('div');trigger.id='pw-launch';
  if(menu){trigger.className='list-group-item flex-container flexGap5';trigger.innerHTML='<div class="fa-solid fa-layer-group"></div><span>提示词工坊</span>';menu.appendChild(trigger);}
  else {trigger.className='pw-fab';trigger.textContent='✦ 提示词工坊';document.body.appendChild(trigger);}
  trigger.addEventListener('click',open);
}

async function init() {
  try {readState();initMenu();
    // 某些主题/加载顺序下扩展菜单稍后才出现：提供独立入口兜底。
    if(!document.querySelector('#extensionsMenu')&&!document.getElementById('pw-launch-menu')) {
      const wait=new MutationObserver(()=>{const menu=document.querySelector('#extensionsMenu');const old=document.getElementById('pw-launch');if(menu&&old?.classList.contains('pw-fab')){old.remove();initMenu();wait.disconnect();}});
      wait.observe(document.body,{childList:true,subtree:true});setTimeout(()=>wait.disconnect(),12000);
    }
    console.log('[提示词工坊] v0.1.0 已加载');
  }catch(e){console.error('[提示词工坊] 初始化失败',e);}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
