// 写卡工坊 · token 估算
// 酒馆有 getTokenCountAsync 时用它（按当前 API 的分词器算）；没有或还没算完时先粗估。

/** 粗估：中日韩字符约 1 token/字，其他按 4 个字符 1 token */
export function estimateTokens(text) {
    const s = String(text ?? '');
    if (!s.trim()) return 0;
    const cjk = (s.match(/[　-〿㐀-鿿豈-﫿＀-￯]/g) ?? []).length;
    return Math.ceil(cjk * 1.0 + (s.length - cjk) / 4);
}

/**
 * 带缓存的计数器。count(text) 立刻返回 {n, exact}；不精确时在后台算，算完调 onUpdate。
 * @param {() => ((s:string)=>Promise<number>)|undefined} getCounter
 * @param {() => void} onUpdate
 */
export function makeTokenCounter(getCounter, onUpdate) {
    const cache = new Map();
    const pending = new Set();
    let timer = null;
    const done = () => { clearTimeout(timer); timer = setTimeout(onUpdate, 120); };
    function queue(text) {
        const f = getCounter();
        if (typeof f !== 'function' || pending.has(text)) return;
        pending.add(text);
        Promise.resolve().then(() => f(text)).then((n) => {
            if (Number.isFinite(n)) {
                cache.set(text, n);
                if (cache.size > 400) cache.delete(cache.keys().next().value);
            }
        }).catch(() => { /* 分词器不可用就一直用估算 */ }).finally(() => { pending.delete(text); done(); });
    }
    function count(text, { exact = true } = {}) {
        const s = String(text ?? '');
        if (!s.trim()) return { n: 0, exact: true };
        if (cache.has(s)) return { n: cache.get(s), exact: true };
        if (exact) queue(s);
        return { n: estimateTokens(s), exact: false };
    }
    function sum(list, o) {
        let n = 0, exact = true;
        for (const t of list) { const r = count(t, o); n += r.n; exact &&= r.exact; }
        return { n, exact };
    }
    return { count, sum };
}

export const fmtTokens = ({ n, exact }) => `${exact ? '' : '约 '}${n.toLocaleString('en-US')} token`;
