// node tests/bridge.test.mjs [八股清理 engine.js 路径]
// 用八股清理的真实规则引擎测试联动；用模拟的酒馆环境测试 API 调用。
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setBaguEngine, baguOptions, baguScan, baguRewrite } from '../src/bagu.js';
import { callLLM, presetMessages } from '../src/llm.js';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

const enginePath = process.argv[2] ?? '../../jiuyi777/bagu-cleaner/engine.js';
const engine = await import(pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), enginePath)).href);
setBaguEngine(engine);

await check('八股清理：读它的设置（我的八股词算必改）', () => {
    const opts = baguOptions({ baguCleaner: { userWords: '低笑' } });
    const s = baguScan('他低笑。嘴角勾起一抹好看的弧度。', opts);
    assert.ok(s.must >= 2, '的弧度 + 低笑');
    assert.equal(baguOptions({}).protectQuotes, true);
});

await check('八股清理：只改含八股的句子，<user> 和 {{char}} 不动', async () => {
    const opts = baguOptions({ baguCleaner: { userWords: '' } });
    const text = '<user>推门进来。{{char}}嘴角勾起一抹若有若无的弧度。窗外在下雨。';
    const calls = [];
    const out = await baguRewrite(text, '开场白', opts, async (sys, prompt) => {
        calls.push(prompt);
        const id = JSON.parse(prompt.slice(prompt.indexOf('【句子】') + 4)).at(0).id;
        return JSON.stringify({ edits: [{ id, text: '{{char}}笑了笑。' }] });
    });
    assert.equal(out.text, '<user>推门进来。{{char}}笑了笑。窗外在下雨。');
    assert.equal(out.changed, 1);
    assert.equal(calls.length, 1);
});

await check('八股清理：没改好的句子单句重做，还不行就保留原句', async () => {
    const opts = baguOptions({ baguCleaner: { userWords: '低笑' } });
    const replies = ['不是 JSON', '{{char}}低笑。'];
    const out = await baguRewrite('{{char}}低笑。', '人设', opts, async () => replies.shift());
    assert.equal(out.text, '{{char}}低笑。');
    assert.equal(out.failed.length, 1);
});

// ───── 模拟酒馆 ─────
const sent = [];
const ctx = {
    chatCompletionSettings: { openai_max_tokens: 4000 },
    extensionSettings: { connectionManager: { profiles: [{ id: 'p1', name: '写卡用' }] } },
    async generateRaw(o) { sent.push({ via: 'raw', ...o }); return '<think>…</think>```\n〔user〕看着〔char〕\n```'; },
    ConnectionManagerRequestService: {
        constructPrompt: (m) => m,
        async sendRequest(profile, prompt, max, custom, override) { sent.push({ via: 'profile', profile, prompt, max, override }); return { content: '好的，〔user〕' }; },
    },
    getPresetManager: () => ({
        getAllPresets: () => ['文风预设'],
        getCompletionPresetByName: (n) => (n !== '文风预设' ? undefined : {
            prompts: [
                { identifier: 'main', role: 'system', content: '写得像小说，<user>是主角' },
                { identifier: 'chatHistory', marker: true },
                { identifier: 'style', role: 'system', content: '少用形容词' },
                { identifier: 'off', role: 'system', content: '关掉的条目' },
            ],
            prompt_order: [
                { character_id: 100000, order: [{ identifier: 'off', enabled: true }] },
                { character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }, { identifier: 'style', enabled: true }, { identifier: 'off', enabled: false }] },
            ],
        }),
    }),
};
globalThis.SillyTavern = { getContext: () => ctx };

await check('预设：只取全局顺序里启用的、有内容的条目', () => {
    assert.deepEqual(presetMessages('文风预设').map((m) => m.content), ['写得像小说，<user>是主角', '少用形容词']);
    assert.deepEqual(presetMessages('不存在'), []);
});

await check('API：当前连接走 generateRaw，宏被保护，返回时换回 <user>', async () => {
    sent.length = 0;
    const out = await callLLM({ system: '系统', user: '<user>和{{char}}', stage: 'greeting', settings: { presetGreeting: '文风预设', minInterval: 0 } });
    assert.equal(out, '<user>看着{{char}}');
    const msgs = sent[0].prompt;
    assert.equal(sent[0].via, 'raw');
    assert.deepEqual(msgs.map((m) => m.content), ['系统', '写得像小说，〔user〕是主角', '少用形容词', '〔user〕和〔char〕']);
    assert.ok(!JSON.stringify(msgs).includes('<user>'));
});

await check('API：写卡阶段不带开场白预设；连接配置文件走 sendRequest 并带温度', async () => {
    sent.length = 0;
    const out = await callLLM({ system: 's', user: 'u', stage: 'card', temperature: 0.9, settings: { apiProfile: 'p1', presetGreeting: '文风预设', useTemperature: true, minInterval: 0 }, userToken: '{{user}}' });
    assert.equal(out, '好的，{{user}}');
    assert.equal(sent[0].via, 'profile');
    assert.equal(sent[0].prompt.length, 2);
    assert.deepEqual(sent[0].override, { temperature: 0.9 });
    assert.equal(sent[0].max, 4000);
});

await check('API：空回复报错', async () => {
    ctx.generateRaw = async () => '   ';
    await assert.rejects(() => callLLM({ system: 's', user: 'u', settings: { minInterval: 0 } }), /空内容/);
});

await check('API：遇到 429 自动等待重试，提示倒计时；一直 429 给出明白的错误', async () => {
    const { callLLM: call } = await import('../src/llm.js');
    let n = 0;
    const waited = [];
    ctx.generateRaw = async () => { n++; if (n < 3) throw new Error('Got response status 429 Too Many Requests'); return '好了'; };
    const out = await call({ system: 's', user: 'u', settings: { minInterval: 0, retryWaits: [1, 1] }, onWait: (sec) => waited.push(sec) });
    assert.equal(out, '好了');
    assert.equal(n, 3);
    assert.deepEqual(waited, [1, 1]);
    ctx.generateRaw = async () => { throw new Error('429'); };
    await assert.rejects(() => call({ system: 's', user: 'u', settings: { minInterval: 0, retryWaits: [0] } }), /一直返回 429/);
    ctx.generateRaw = async () => { throw new Error('别的错误'); };
    await assert.rejects(() => call({ system: 's', user: 'u', settings: { minInterval: 0, retryWaits: [0] } }), /别的错误/);
});

await check('API：两次调用之间按设置间隔', async () => {
    const { callLLM: call } = await import('../src/llm.js');
    const times = [];
    ctx.generateRaw = async () => { times.push(Date.now()); return 'x'; };
    await call({ system: 's', user: 'u', settings: { minInterval: 0.3 } });
    await call({ system: 's', user: 'u', settings: { minInterval: 0.3 } });
    assert.ok(times[1] - times[0] >= 280, `间隔 ${times[1] - times[0]}ms`);
});

await check('八股清理：整批格式错了只整批重来，单句重做最多 3 次', async () => {
    const opts = baguOptions({ baguCleaner: { userWords: '低笑' } });
    const text = Array.from({ length: 8 }, (_, i) => `他${i}低笑。`).join('');
    let calls = 0;
    const out = await baguRewrite(text, '人设', opts, async () => { calls++; return '不是 JSON'; });
    assert.equal(calls, 2 + 3, '整批 2 次 + 单句 3 次');
    assert.equal(out.failed.length, 5, '超过上限的 5 句直接保留原句');
    const ex = baguOptions({ baguCleaner: { userWords: '' } }, ['执念']);
    assert.ok(baguScan('他的执念', ex).must >= 1, '写卡工坊的禁用词也算必改');
});

console.log(`\n${passed} passed`);
