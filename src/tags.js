// 写卡工坊 · 标签库（不依赖 DOM，可在 Node 里测试）
// 每个标签写成「名称|触发词,触发词」。触发词出现在一句话脑洞里就自动勾上。

const RAW = [
    {
        key: 'cardType', name: '卡类型', single: true, required: true, tags: [
            '单人卡|单人,一个角色',
            '大世界卡|大世界,开放世界,冒险,RPG,跑团',
            '手枪卡|手枪,纯肉,h卡',
            '模拟器/系统卡|模拟器,系统卡,经营,养成卡',
        ],
    },
    {
        key: 'source', name: '来源', single: true, required: true, tags: [
            '原创|原创',
            '同人|同人,原作,二创,衍生,原著',
        ],
    },
    {
        key: 'cp', name: '性向', required: true, tags: [
            'BG|BG,言情,男女主',
            'GB|GB,女攻,女强男弱',
            'BL|BL,耽美,纯爱,男男',
            'GL|GL,百合,女女',
            '无CP|无CP,不谈恋爱,纯友情,事业线',
        ],
    },
    {
        key: 'count', name: '人数', single: true, required: true, tags: [
            '1v1|1v1,1V1,一对一,双洁',
            'NP|NP,多男主,多女主,后宫',
            '群像|群像,多人,小队,团队',
            '多线可选|多线,多路线,多结局',
        ],
    },
    {
        key: 'userRole', name: 'user 身份', single: true, tags: [
            '主角|',
            '旁观者|旁观,路人',
            '自定义|',
        ],
    },
    {
        key: 'userGender', name: 'user 性别', single: true, tags: [
            '女|女主,女user,女性向',
            '男|男主视角,男user,男性向',
            '不限|不限性别',
        ],
    },
    {
        key: 'era', name: '时代与题材', tags: [
            '现言|现代,都市,现言',
            '古言|古代,古风,古言,王爷,侯爷',
            '民国|民国,军阀,上海滩',
            '年代|年代文,七零,八零,九十年代',
            '仙侠|仙侠,修仙,仙尊,宗门,师尊,飞升',
            '玄幻|玄幻,异世,魔法',
            '武侠|武侠,江湖,门派,侠客',
            '宫廷|宫廷,皇宫,太子,后妃',
            '宅斗|宅斗,嫡庶,侯府,主母',
            '豪门|豪门,世家,继承人,联姻',
            '娱乐圈|娱乐圈,明星,影帝,影后,顶流,爱豆',
            '电竞|电竞,战队,职业选手',
            '校园|校园,学校,学长,学姐,同桌,高中,大学',
            '职场|职场,上司,公司,同事,下属',
            '刑侦|刑侦,刑警,破案,法医,凶案',
            '悬疑|悬疑,谜团,凶手,真相',
            '灵异|灵异,鬼魂,阴阳,驱魔,捉鬼',
            '规则怪谈|规则怪谈,怪谈',
            '末世|末世,丧尸,天灾,避难所',
            '废土|废土',
            '星际|星际,星舰,机甲,帝国元帅',
            '赛博朋克|赛博,义体,赛博朋克',
            '西幻|西幻,骑士,魔王,精灵,教会,主教,圣女',
            '克苏鲁|克苏鲁,邪神,古神,不可名状',
            'ABO|ABO,alpha,omega,信息素,发情期',
            '兽人|兽人,兽世,兽耳',
            '种田|种田,农家,田园',
            '无限流|无限流,副本,逃生游戏',
            '快穿|快穿',
            '穿书|穿书,炮灰,原书剧情',
            '都市异能|异能,超能力,觉醒者',
            '军旅|军旅,军人,部队,军校',
            '医疗|医院,医疗,外科,急诊',
            '宗教神明|神明,信徒,神殿,神父,修女,神谕',
        ],
    },
    {
        key: 'archetype', name: '角色原型', tags: [
            '霸总|霸总,总裁,董事长,CEO',
            '京圈太子爷|太子爷,京圈',
            '疯批|疯批',
            '病娇|病娇,偏执',
            '清冷仙尊|仙尊,清冷',
            '高岭之花|高岭之花,高冷',
            '魔尊|魔尊,魔头',
            '神明|神明,神祇',
            '帝王|帝王,皇帝,陛下,暴君',
            '将军|将军,大将军',
            '杀手|杀手,刺客',
            '黑道|黑道,黑帮,帮派老大',
            '反派|反派,大反派',
            '忠犬|忠犬',
            '狼狗|狼狗',
            '奶狗|奶狗',
            '腹黑|腹黑',
            '白切黑|白切黑',
            '美强惨|美强惨',
            '小白花|小白花',
            '绿茶|绿茶',
            '落魄贵族|落魄,没落贵族',
            '学霸|学霸',
            '混混|混混,校霸,不良',
            '偶像|偶像',
            '医生|医生',
            '律师|律师',
            '警察|警察,刑警',
            '老师|老师,教授,导师',
            '神父/修女|神父,修女,牧师',
            '竹马|竹马',
            '继兄|继兄,继妹,继姐',
            '质子|质子',
            '公主|公主',
            '魔女|魔女,女巫',
            '骑士|骑士',
            '扒手/盗贼|扒手,小偷,盗贼,怪盗',
            '孤儿|孤儿',
        ],
    },
    {
        key: 'relation', name: '关系结构', tags: [
            '青梅竹马|青梅竹马,一起长大,从小认识',
            '天降|天降',
            '契约婚姻|契约,协议结婚,合约',
            '先婚后爱|先婚后爱',
            '联姻|联姻,商业联姻',
            '宿敌|宿敌',
            '死对头|死对头,冤家',
            '师徒|师徒,徒弟',
            '主仆|主仆,侍卫,管家,侍从',
            '君臣|君臣',
            '养成|养成,捡来,收养,养父,义父,养母',
            '年上|年上',
            '年下|年下',
            '强取豪夺|强取豪夺,强制爱',
            '追妻火葬场|火葬场,追妻',
            '破镜重圆|破镜重圆,重逢,分手',
            '救赎|救赎',
            '互相救赎|互相救赎',
            '替身|替身,白月光',
            '暗恋|暗恋',
            '双向暗恋|双向暗恋',
            '假戏真做|假戏真做,假扮情侣',
            '伪骨科|伪骨科',
            '禁忌|禁忌,不伦',
            '敌对阵营|敌对,阵营,卧底',
            '前任|前任,前男友,前女友',
            '网恋奔现|网恋,奔现',
            '相爱相杀|相爱相杀',
        ],
    },
    {
        key: 'plot', name: '情节梗', tags: [
            '重生|重生',
            '穿越|穿越',
            '系统|系统',
            '掉马|掉马',
            '马甲|马甲',
            '双重身份|双重身份,隐藏身份',
            '修罗场|修罗场',
            '黑化|黑化',
            '失忆|失忆,不记得,忘了我',
            '替嫁|替嫁',
            '退婚|退婚',
            '逃婚|逃婚',
            '带球跑|带球跑',
            '打脸|打脸',
            '复仇|复仇,报仇',
            '真假千金|真假千金,真千金,假千金',
            '扮猪吃虎|扮猪吃虎',
            '囚禁|囚禁,关起来,金丝雀',
            '循环|循环,轮回,重置,回档',
            '死遁|死遁,假死',
            'HE|HE,圆满',
            'BE|BE,永别,离去',
            '开放结局|开放结局',
        ],
    },
    {
        key: 'flavor', name: '风味', tags: [
            '甜宠|甜宠,甜文,小甜',
            '虐恋|虐恋,虐文,很虐',
            '极限拉扯|拉扯',
            '酸涩|酸涩,遗憾,错过',
            '糖里藏刀|糖里藏刀',
            '刀子|刀子',
            '沙雕|沙雕,搞笑,搞怪',
            '轻松日常|日常,轻松',
            '治愈|治愈',
            '温情|温情,温馨',
            '暗黑|暗黑,黑暗向',
            '致郁|致郁',
            '爽文|爽文,爽点',
            '悬疑烧脑|烧脑',
            '史诗|史诗',
            '群像戏|群像戏',
        ],
    },
    {
        key: 'rating', name: '尺度', single: true, tags: [
            '清水|清水',
            '微肉|微肉',
            '肉|NSFW,色色,涩涩,开车',
        ],
    },
    {
        key: 'platform', name: '平台味', single: true, tags: [
            '晋江味|晋江',
            '起点味|起点',
            '长佩味|长佩',
            '番茄味|番茄',
        ],
    },
    {
        key: 'complexity', name: '世界观复杂度', single: true, tags: [
            '简单|',
            '中等|',
            '复杂|',
        ],
    },
];

export const PLATFORM_STYLE = {
    '晋江味': '情感拉扯为主线，心理细腻，关系的每一步推进都要有来由和代价',
    '起点味': '事业线与成长为主线，目标清楚，爽点节奏明确，感情服务于成长',
    '长佩味': '克制细腻，生活质感强，情感在日常细节里慢慢积累',
    '番茄味': '节奏快，钩子密，冲突直给，每段都有推进',
};

/** 把一条「名称|触发词」解析成对象 */
export function parseTag(line, dim) {
    const [name, trig = ''] = String(line).split('|');
    const triggers = trig.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    return { name: name.trim(), dim, triggers };
}

/**
 * 组装标签库：默认标签 + 用户自定义标签（custom: {维度key: ['名称|触发词', ...]}）
 * @returns {{key:string,name:string,single?:boolean,required?:boolean,tags:{name:string,dim:string,triggers:string[]}[]}[]}
 */
export function buildLibrary(custom = {}) {
    return RAW.map((d) => {
        const tags = [...d.tags, ...(custom?.[d.key] ?? [])].map((t) => parseTag(t, d.key)).filter((t) => t.name);
        const seen = new Set();
        return { ...d, tags: tags.filter((t) => (seen.has(t.name) ? false : seen.add(t.name))) };
    });
}

export function dimOf(lib, key) {
    return lib.find((d) => d.key === key || d.name === key);
}

/** 根据名称找标签所在维度（可指定维度优先） */
export function findTag(lib, name, dimKey) {
    const n = String(name ?? '').trim();
    if (!n) return null;
    if (dimKey) {
        const d = dimOf(lib, dimKey);
        const t = d?.tags.find((x) => x.name === n);
        if (t) return t;
    }
    for (const d of lib) {
        const t = d.tags.find((x) => x.name === n);
        if (t) return t;
    }
    return null;
}

const isAscii = (s) => /^[\x20-\x7e]+$/.test(s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 一个触发词是否出现在文本里。英文触发词按单词边界匹配（HE 不会命中 THE）。 */
export function hasTrigger(text, trig) {
    if (!trig) return false;
    if (isAscii(trig)) {
        return new RegExp(`(?<![A-Za-z])${escapeRe(trig)}(?![A-Za-z])`, 'i').test(text);
    }
    return text.includes(trig);
}

/**
 * 本地匹配：返回命中的标签（每个带 dim、name、hit）。单选维度只保留第一个命中。
 */
export function matchTags(text, lib) {
    const src = String(text ?? '');
    const out = [];
    for (const d of lib) {
        const hits = [];
        for (const t of d.tags) {
            const hit = t.triggers.find((tr) => hasTrigger(src, tr));
            if (hit) hits.push({ dim: d.key, name: t.name, hit });
        }
        if (d.single) {
            if (hits.length) {
                // 单选：取出现位置最靠前的
                hits.sort((a, b) => src.indexOf(a.hit) - src.indexOf(b.hit));
                out.push(hits[0]);
            }
        } else out.push(...hits);
    }
    return out;
}

/** 给 AI 看的标签库列表：「维度：a、b、c」 */
export function libraryText(lib, skip = ['complexity']) {
    return lib.filter((d) => !skip.includes(d.key))
        .map((d) => `${d.name}${d.single ? '（单选）' : ''}：${d.tags.map((t) => t.name).join('、')}`)
        .join('\n');
}

/**
 * 选中的标签。selected: [{dim,name}]。单选维度加入新标签时替换旧的。
 */
export function toggleTag(selected, lib, dim, name, on = true) {
    const d = dimOf(lib, dim);
    let list = (selected ?? []).filter((t) => !(t.dim === dim && t.name === name));
    if (on) {
        if (d?.single) list = list.filter((t) => t.dim !== dim);
        list.push({ dim, name });
    }
    return list;
}

/** AI 返回的标签名不在库里就丢掉（新标签走 novel 单独确认） */
export function sanitizeTags(names, lib) {
    const out = [];
    for (const n of names ?? []) {
        const name = typeof n === 'string' ? n : n?.name;
        const t = findTag(lib, name, typeof n === 'object' ? n?.dim : undefined);
        if (t && !out.some((x) => x.dim === t.dim && x.name === t.name)) out.push({ dim: t.dim, name: t.name });
    }
    return out;
}

/** 按维度格式化选中标签：「性向：BG；人数：1v1；…」 */
export function tagsText(selected, lib) {
    return lib.map((d) => {
        const names = (selected ?? []).filter((t) => t.dim === d.key).map((t) => t.name);
        return names.length ? `${d.name}：${names.join('、')}` : '';
    }).filter(Boolean).join('；');
}

export function tagValue(selected, dim) {
    return (selected ?? []).filter((t) => t.dim === dim).map((t) => t.name);
}

/** 最多 8 个标签，按 性向 → 人数 → 题材 → 关系 → 风味 → 其他 排序（用于简介标题） */
export function introTags(selected, max = 8) {
    const order = ['cp', 'count', 'era', 'relation', 'flavor', 'plot', 'archetype', 'rating'];
    const list = [];
    for (const k of order) for (const t of selected ?? []) if (t.dim === k && !list.includes(t.name)) list.push(t.name);
    return list.slice(0, max);
}

/** 灵感骰子：从几个维度各随机抽一个，lock 里的维度保持不变 */
export function rollDice(lib, lock = {}, rand = Math.random) {
    const dims = ['era', 'archetype', 'relation', 'plot', 'flavor'];
    const out = {};
    for (const k of dims) {
        if (lock[k]) { out[k] = lock[k]; continue; }
        const d = dimOf(lib, k);
        if (!d?.tags.length) continue;
        out[k] = d.tags[Math.floor(rand() * d.tags.length)].name;
    }
    return out;
}
