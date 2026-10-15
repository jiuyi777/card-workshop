// 提示词工坊 · 与 DOM / SillyTavern 解耦的数据层
export const MODULE = 'promptWorkshop';
export const BUILTIN_ANCHORS = [
  { key: 'start', label: '头部（主提示词之后）' },
  { key: 'beforeCharacter', label: '角色定义之前' },
  { key: 'beforeHistory', label: '聊天记录之前' },
  { key: 'afterHistory', label: '聊天记录之后' },
  { key: 'end', label: '末尾' },
  { key: 'inChat', label: '聊天内注入（D0 / D1 / D2…）' },
];
export const WRITE_MODES = {
  module: {
    label: '模块型',
    system: `你是一名 SillyTavern 对话补全预设的提示词架构师。任务是把需求写成能独立复用的功能模块。\n
以可执行的控制规则为主，定义输入、约束、优先级、工作顺序、输出格式、冲突处理。将抽象的创作目标落实为模型可以逐项执行的条件。仅写完成任务所需的规则，不写空洞口号、作者身份介绍、赞美、解释你如何完成任务。\n
不得预设用户的剧情选择，不得覆盖模型当前接收的角色卡、世界书；应当能与其他模块组合。保留 {{user}}、{{char}}、<user> 等宏的原始写法（消息中若使用占位符〔user_macro〕与〔char_macro〕，原样保留，输出结束后会恢复）。\n
只输出提示词正文，不要代码围栏，不要附加说明。`,
  },
  rule: {
    label: '规则型',
    system: `你是一名 SillyTavern 对话补全预设的规则编辑者。针对需求建立可检查的生成约束。\n
给出规则的作用域、触发条件（如果确实需要）、执行动作、例外和冲突优先级。偏好明确动作与判定标准，不用“尽量、充分、更加生动”这样的程度词，不要把抽象形容词排列成一串。可以使用编号、XML 或短段落，但每条都必须具体。\n
规则应当可作为单个预设条目独立运行。不要安排 {{user}} 的回应，不覆盖卡内既有设定，不能要求输出内部隐私或模型的隐藏推理。保留〔user_macro〕与〔char_macro〕占位符。\n
只输出可直接粘贴的提示词正文，不要解释。`,
  },
  style: {
    label: '文风型',
    system: `你是一名 SillyTavern 对话补全预设的文风设计者。把用户的审美偏好写成写作过程中可操作的选择规则。\n
具体规定句子结构、叙述视角、用词、对话、节奏、细节分配、篇幅和应删除的套路句；用正负简短示例说明重要差别（用户要求才使用示例）。不要套用“细腻而富有张力”等无法检验的宣言。\n
遵守角色卡的人物性格与已发生事件，不抢写 {{user}} 行动。保留〔user_macro〕与〔char_macro〕占位符。\n
只输出文风提示词正文，不要解释。`,
  },
};

export const defaultMarkers = [
  ['main', 'Main Prompt', false, 'Write {{char}}\'s next reply in a fictional chat between {{char}} and {{user}}.'],
  ['nsfw', 'Auxiliary Prompt', false, ''],
  ['worldInfoBefore', 'World Info (before)', true],
  ['personaDescription', 'Persona Description', true],
  ['charDescription', 'Char Description', true],
  ['charPersonality', 'Char Personality', true],
  ['scenario', 'Scenario', true],
  ['enhanceDefinitions', 'Enhance Definitions', false, ''],
  ['worldInfoAfter', 'World Info (after)', true],
  ['dialogueExamples', 'Chat Examples', true],
  ['chatHistory', 'Chat History', true],
  ['jailbreak', 'Post-History Instructions', false, ''],
];

const primaryOrder = ['main', 'worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario', 'enhanceDefinitions', 'nsfw', 'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'jailbreak'];
const noPersonaOrder = primaryOrder.filter(x => x !== 'personaDescription');

export function defaultPreset() {
  return {
    name: '提示词工坊',
    chat_completion_source: 'openai',
    openai_max_context: 16384,
    openai_max_tokens: 2048,
    wi_format: '{0}',
    scenario_format: '{{scenario}}',
    personality_format: '{{personality}}',
    prompts: defaultMarkers.map(([identifier, name, marker, content]) => ({
      identifier, name, system_prompt: !marker,
      ...(marker ? { marker: true } : { role: 'system', content: content || '' }),
    })),
    prompt_order: [
      { character_id: 100000, order: noPersonaOrder.map(identifier => ({ identifier, enabled: identifier !== 'enhanceDefinitions' })) },
      { character_id: 100001, order: primaryOrder.map(identifier => ({ identifier, enabled: identifier !== 'enhanceDefinitions' })) },
    ],
  };
}

export const clone = value => JSON.parse(JSON.stringify(value));
export const newId = () => 'pw-' + (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
export const unique = xs => [...new Set(xs)];
export const tagsOf = text => unique(String(text ?? '').split(/[，,、\n]/).map(x => x.trim()).filter(Boolean));

export function makeEntry(data = {}) {
  return {
    id: data.id || newId(),
    name: String(data.name || '未命名条目').trim(),
    content: String(data.content ?? ''),
    role: ['system', 'user', 'assistant'].includes(data.role) ? data.role : 'system',
    anchor: BUILTIN_ANCHORS.some(x => x.key === data.anchor) ? data.anchor : 'beforeHistory',
    depth: Math.max(0, Math.min(99, Number(data.depth) || 0)),
    injectionOrder: Math.max(0, Math.min(9999, Number(data.injectionOrder) || 100)),
    enabled: data.enabled !== false,
    tags: Array.isArray(data.tags) ? unique(data.tags.map(String).map(x => x.trim()).filter(Boolean)) : tagsOf(data.tags),
    rawPrompt: data.rawPrompt && typeof data.rawPrompt === 'object' ? clone(data.rawPrompt) : null,
    created: Number(data.created) || Date.now(),
    updated: Date.now(),
  };
}

export function newAssembly(name = '我的预设') {
  return { id: newId(), name, order: [], selected: {}, enabled: {} };
}

export function emptyState() {
  const a = newAssembly();
  return {
    version: 1,
    entries: [], assemblies: [a], activeAssembly: a.id,
    apiProfile: '', writingPreset: '', minInterval: 3, maxTokens: 0,
    basePreset: null, baseName: '',
    draft: { editId: '', name: '', mode: 'module', role: 'system', anchor: 'beforeHistory', depth: 0, injectionOrder: 100, tags: '', request: '', content: '' },
  };
}

export function sanitizeState(saved) {
  const d = emptyState();
  if (!saved || typeof saved !== 'object') return d;
  const entries = (Array.isArray(saved.entries) ? saved.entries : []).map(makeEntry);
  const ids = new Set(entries.map(x => x.id));
  const assemblies = (Array.isArray(saved.assemblies) ? saved.assemblies : []).map(a => ({
    id: String(a.id || newId()), name: String(a.name || '我的预设'),
    order: unique((Array.isArray(a.order) ? a.order : []).map(String)).filter(x => ids.has(x)),
    selected: Object.fromEntries(Object.entries(a.selected || {}).filter(([k]) => ids.has(k)).map(([k,v])=>[k,!!v])),
    enabled: Object.fromEntries(Object.entries(a.enabled || {}).filter(([k]) => ids.has(k)).map(([k,v])=>[k,!!v])),
  }));
  if (!assemblies.length) assemblies.push(d.assemblies[0]);
  const draft = saved.draft && typeof saved.draft === 'object' ? { ...d.draft, ...saved.draft } : d.draft;
  return {
    ...d, entries, assemblies,
    activeAssembly: assemblies.some(x => x.id === saved.activeAssembly) ? saved.activeAssembly : assemblies[0].id,
    apiProfile: String(saved.apiProfile || ''), writingPreset: String(saved.writingPreset || ''),
    minInterval: Math.max(0, Number(saved.minInterval ?? 3)), maxTokens: Math.max(0, Number(saved.maxTokens || 0)),
    basePreset: isNativePreset(saved.basePreset) ? clone(unwrapPreset(saved.basePreset)) : null,
    baseName: String(saved.baseName || ''), draft,
  };
}

export function currentAssembly(state) {
  return state.assemblies.find(x => x.id === state.activeAssembly) || state.assemblies[0];
}

export function unwrapPreset(input) {
  if (input?.data && typeof input.data === 'object' && Array.isArray(input.data.prompts)) return input.data;
  return input;
}
export function isNativePreset(value) {
  const p = unwrapPreset(value);
  return !!p && typeof p === 'object' && !Array.isArray(p) && Array.isArray(p.prompts) && Array.isArray(p.prompt_order);
}

export function importEntries(preset, existing = []) {
  const p = unwrapPreset(preset);
  if (!isNativePreset(p)) throw new Error('这不是酒馆对话补全预设：需要 prompts 和 prompt_order。');
  const map = new Map();
  for (const group of p.prompt_order) for (const row of group.order || []) if (!map.has(row.identifier)) map.set(row.identifier, !!row.enabled);
  const used = new Set(existing.map(x => x.id));
  return p.prompts.filter(x => x && !x.marker && String(x.content ?? '').trim()).map(x => {
    const id = newId();
    if (used.has(id)) throw new Error('条目 ID 冲突');
    used.add(id);
    return makeEntry({
      id, name: x.name || '未命名条目', content: x.content, role: x.role, enabled: map.has(x.identifier) ? map.get(x.identifier) : x.enabled !== false,
      anchor: Number(x.injection_position || 0) === 1 ? 'inChat' : 'beforeHistory',
      depth: x.injection_depth || 0, injectionOrder: x.injection_order || 100,
      tags: ['导入'], rawPrompt: x,
    });
  });
}

export function ensureAssemblyTracks(state, items, selected = false) {
  for (const a of state.assemblies) for (const item of items) {
    if (!a.order.includes(item.id)) a.order.push(item.id);
    if (!(item.id in a.selected)) a.selected[item.id] = selected;
    if (!(item.id in a.enabled)) a.enabled[item.id] = item.enabled;
  }
}

export function toNativePrompt(e) {
  const raw = e.rawPrompt ? clone(e.rawPrompt) : {};
  const abs = e.anchor === 'inChat';
  return {
    ...raw, identifier: e.id, name: e.name, role: e.role, content: e.content,
    system_prompt: false, marker: false,
    injection_position: abs ? 1 : 0,
    injection_depth: abs ? e.depth : 4,
    injection_order: e.injectionOrder,
    injection_trigger: Array.isArray(raw.injection_trigger) ? raw.injection_trigger : [],
    forbid_overrides: !!raw.forbid_overrides,
  };
}

function addRelativeRows(baseOrder, list) {
  // 在每个锚点批量插入，保留拖拽决定的相对顺序。
  const result = baseOrder.slice();
  const anchors = {
    start: { names: ['main'], after: true, fallback: 0 },
    beforeCharacter: { names: ['charDescription','personaDescription','charPersonality'], after: false, fallback: 0 },
    beforeHistory: { names: ['chatHistory'], after: false, fallback: result.length },
    afterHistory: { names: ['chatHistory'], after: true, fallback: result.length },
    end: { names: [], after: true, fallback: result.length },
  };
  // 先处理倒序的锚点，避免新插入的项目影响后续同锚点的位置。
  for (const key of ['end','afterHistory','beforeHistory','beforeCharacter','start']) {
    const picked = list.filter(x => x.anchor === key);
    if (!picked.length) continue;
    const config = anchors[key];
    const anchorAt = config.names.length ? result.findIndex(x => config.names.includes(x.identifier)) : -1;
    const at = anchorAt < 0 ? Math.min(result.length, config.fallback) : anchorAt + (config.after ? 1 : 0);
    result.splice(at, 0, ...picked.map(x => ({ identifier: x.id, enabled: x.active })));
  }
  return result;
}

export function buildPreset(state, base = null, { name = '' } = {}) {
  const template = isNativePreset(base) ? unwrapPreset(base) : (isNativePreset(state.basePreset) ? unwrapPreset(state.basePreset) : defaultPreset());
  const p = clone(template);
  const a = currentAssembly(state);
  const byId = new Map(state.entries.map(x => [x.id, x]));
  const picks = unique(a.order).filter(id => a.selected[id] && byId.has(id)).map(id => ({ ...byId.get(id), active: a.enabled[id] !== false }));
  // 用户可能手动删除某个条目库元素，先剔除底稿中与本插件同 ID 的旧条目以避免重复。
  const ids = new Set(picks.map(x => x.id));
  p.prompts = p.prompts.filter(x => !ids.has(x.identifier));
  const baseIds = new Set(p.prompts.map(x => x.identifier));
  p.prompts.push(...picks.filter(x => !baseIds.has(x.id)).map(toNativePrompt));
  if (!Array.isArray(p.prompt_order) || !p.prompt_order.length) p.prompt_order = clone(defaultPreset().prompt_order);
  p.prompt_order = p.prompt_order.map(group => {
    const original = (Array.isArray(group.order) ? group.order : []).filter(x => !ids.has(x.identifier));
    const relative = picks.filter(x => x.anchor !== 'inChat');
    const inChat = picks.filter(x => x.anchor === 'inChat').map(x => ({ identifier: x.id, enabled: x.active }));
    const order = [...addRelativeRows(original, relative), ...inChat];
    return { ...group, order };
  });
  if (name) p.name = name;
  return p;
}

export function validatePreset(p) {
  const errors = [];
  if (!isNativePreset(p)) return ['预设格式无效'];
  const ids = new Set();
  for (const x of p.prompts) {
    if (!x.identifier) errors.push('存在缺少 identifier 的条目');
    if (ids.has(x.identifier)) errors.push(`重复 identifier：${x.identifier}`);
    ids.add(x.identifier);
  }
  for (const group of p.prompt_order) {
    const seen = new Set();
    for (const x of group.order || []) {
      if (!ids.has(x.identifier)) errors.push(`排序引用了缺失条目：${x.identifier}`);
      if (seen.has(x.identifier)) errors.push(`重复排序条目：${x.identifier}`);
      seen.add(x.identifier);
    }
    if (!seen.has('chatHistory')) errors.push(`角色模式 ${group.character_id} 缺少聊天记录标记`);
  }
  return unique(errors);
}

export function formatWriterMessages({ mode = 'module', request, name, previous = '', feedback = '' }) {
  const m = WRITE_MODES[mode] || WRITE_MODES.module;
  const normalized = String(request || '').replace(/\{\{\s*user\s*\}\}/gi, '〔user_macro〕').replace(/\{\{\s*char\s*\}\}/gi,'〔char_macro〕');
  const old = String(previous || '').replace(/\{\{\s*user\s*\}\}/gi,'〔user_macro〕').replace(/\{\{\s*char\s*\}\}/gi,'〔char_macro〕');
  return {
    system: m.system,
    user: `【条目名称】${String(name || '未命名')}\n【具体需求】\n${normalized}\n${old ? `\n【现有版本】\n${old}\n【修改要求】在现有版本上按需求修改，保留没有要求改动的规则。\n` : ''}${feedback ? `\n【附加意见】\n${feedback}` : ''}\n直接输出可以保存到 SillyTavern 预设条目的完整提示词。`,
  };
}

export function restoreMacros(text) {
  return String(text ?? '').replaceAll('〔user_macro〕', '{{user}}').replaceAll('〔char_macro〕', '{{char}}');
}
