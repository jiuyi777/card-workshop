// 写卡工坊 · 改了哪里
// 按行比较两版，返回改动的片段：[{before, after}]。before 空 = 新加的，after 空 = 删掉的。

export function diffLines(a, b) {
    const A = String(a ?? '').split('\n');
    const B = String(b ?? '').split('\n');
    if (A.join('\n') === B.join('\n')) return [];
    // 先去掉相同的开头和结尾，中间再做 LCS
    let s = 0;
    while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let ea = A.length, eb = B.length;
    while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
    const a2 = A.slice(s, ea);
    const b2 = B.slice(s, eb);
    if (a2.length * b2.length > 250000) return [{ before: a2.join('\n'), after: b2.join('\n') }];
    const n = a2.length, m = b2.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const hunks = [];
    let cur = null;
    const flush = () => { if (cur) { hunks.push({ before: cur.before.join('\n'), after: cur.after.join('\n') }); cur = null; } };
    let i = 0, j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a2[i] === b2[j]) { flush(); i++; j++; continue; }
        cur ??= { before: [], after: [] };
        if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) cur.before.push(a2[i++]);
        else cur.after.push(b2[j++]);
    }
    flush();
    // 只差空白的不算
    return hunks.filter((h) => h.before.trim() !== h.after.trim());
}
