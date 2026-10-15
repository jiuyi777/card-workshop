import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPreset, emptyState, makeEntry, ensureAssemblyTracks, currentAssembly, buildPreset,
  importEntries, validatePreset, newAssembly, toNativePrompt, isNativePreset,
  formatWriterMessages, restoreMacros, sanitizeState} from '../src/core.js';

function makeState() {
  const state=emptyState();
  const items=[
    makeEntry({id:'pw-head',name:'头部',content:'head',anchor:'start',role:'system',tags:'破限'}),
    makeEntry({id:'pw-characters',name:'角色前',content:'char',anchor:'beforeCharacter',role:'user'}),
    makeEntry({id:'pw-bh1',name:'记录之前 A',content:'A',anchor:'beforeHistory'}),
    makeEntry({id:'pw-bh2',name:'记录之前 B',content:'B',anchor:'beforeHistory'}),
    makeEntry({id:'pw-ah',name:'记录之后',content:'C',anchor:'afterHistory',role:'assistant'}),
    makeEntry({id:'pw-end',name:'末尾',content:'D',anchor:'end'}),
    makeEntry({id:'pw-d0',name:'D0',content:'D0',anchor:'inChat',depth:0,injectionOrder:333}),
  ];
  state.entries.push(...items);
  ensureAssemblyTracks(state,items,true);
  return state;
}

test('默认底稿保留世界书、角色定义、聊天记录标记与两套顺序',()=>{
  const p=defaultPreset();
  assert.ok(isNativePreset(p));
  assert.deepEqual(validatePreset(p),[]);
  assert.equal(p.prompt_order.length,2);
  assert.ok(p.prompts.some(x=>x.identifier==='chatHistory'&&x.marker));
});

test('拼装锚点插入顺序正确；禁用条目保留为开关；不破坏底稿',()=>{
  const state=makeState();
  const base=defaultPreset();base.temperature=.43;base.custom_provider_setting='unchanged';
  const a=currentAssembly(state);a.enabled['pw-bh2']=false;
  const result=buildPreset(state,base,{name:'测试方案'});
  assert.deepEqual(validatePreset(result),[]);
  assert.equal(result.temperature,.43);
  assert.equal(result.custom_provider_setting,'unchanged');
  assert.equal(base.prompts.length,12);
  assert.equal(result.name,'测试方案');
  const order=result.prompt_order[1].order;
  const ids=order.map(x=>x.identifier);
  assert.equal(ids.indexOf('pw-head'),ids.indexOf('main')+1);
  assert.ok(ids.indexOf('pw-characters')<ids.indexOf('charDescription'));
  assert.equal(ids.indexOf('pw-bh1')+1,ids.indexOf('pw-bh2'));
  assert.equal(ids.indexOf('pw-bh2')+1,ids.indexOf('chatHistory'));
  assert.equal(ids.indexOf('chatHistory')+1,ids.indexOf('pw-ah'));
  assert.equal(ids.at(-2),'pw-end');
  assert.equal(ids.at(-1),'pw-d0');
  assert.equal(order.find(x=>x.identifier==='pw-bh2').enabled,false);
  for(const group of result.prompt_order)assert.ok(group.order.some(x=>x.identifier==='pw-d0'));
  const d0=result.prompts.find(x=>x.identifier==='pw-d0');
  assert.equal(d0.injection_position,1);
  assert.equal(d0.injection_depth,0);
  assert.equal(d0.injection_order,333);
});

test('方案选择与启用独立，条目库共享',()=>{
  const state=makeState();
  const second=newAssembly('第二份');state.assemblies.push(second);
  ensureAssemblyTracks(state,state.entries,false);
  second.selected['pw-head']=true;
  state.activeAssembly=second.id;
  const p=buildPreset(state);
  assert.equal(p.prompts.filter(x=>x.identifier.startsWith('pw-')).length,1);
  state.activeAssembly=state.assemblies[0].id;
  assert.equal(buildPreset(state).prompts.filter(x=>x.identifier.startsWith('pw-')).length,7);
});

test('现有预设条目导入库，保留正文及原生的额外字段，不混进 marker',()=>{
  const base=defaultPreset();
  base.prompts.push({identifier:'old-id',name:'原来条目',role:'assistant',content:'原文不能改',enabled:true,injection_position:1,injection_depth:2,foreign_setting:42});
  for(const o of base.prompt_order)o.order.push({identifier:'old-id',enabled:false});
  const entries=importEntries(base);
  const x=entries.find(x=>x.name==='原来条目');
  assert.ok(x);
  assert.equal(x.content,'原文不能改');
  assert.equal(x.enabled,false);
  assert.equal(x.role,'assistant');
  assert.equal(x.anchor,'inChat');
  assert.equal(x.depth,2);
  const native=toNativePrompt(x);
  assert.equal(native.foreign_setting,42);
  assert.ok(x.id!=='old-id');
  assert.equal(entries.some(x=>x.name==='Chat History'),false);
});

test('快照恢复能过滤已删除的条目引用',()=>{
  const state=makeState();
  state.assemblies[0].order.push('id-no-longer-exists');
  const restored=sanitizeState(JSON.parse(JSON.stringify(state)));
  assert.ok(!restored.assemblies[0].order.includes('id-no-longer-exists'));
});

test('写作请求保留变量宏，响应能恢复宏',()=>{
  const r=formatWriterMessages({mode:'rule',name:'玩家保护',request:'不得代理 {{user}} 的选择，要处理 {{char}} 的情绪'});
  assert.ok(r.user.includes('〔user_macro〕'));
  assert.ok(r.user.includes('〔char_macro〕'));
  assert.equal(restoreMacros('A 〔user_macro〕 B 〔char_macro〕'),'A {{user}} B {{char}}');
});

test('缺失聊天历史标记会报告错误',()=>{
  const p=defaultPreset();
  p.prompt_order[0].order=p.prompt_order[0].order.filter(x=>x.identifier!=='chatHistory');
  assert.ok(validatePreset(p).some(x=>x.includes('聊天记录')));
});
