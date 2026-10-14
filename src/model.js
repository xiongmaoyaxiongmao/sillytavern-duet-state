export const KEY = 'duet_state';
export const GROUPS = { relationship: '关系', mind: '心理', body: '身体', physiology: '生理' };
export const ACTORS = ['char', 'user'];
export const clone = value => structuredClone(value);

const catalog = [
    ['affection', '好感', 'relationship', 30, '依据实际关系和互动改变，不把好感等同于信任、同意或承诺。'],
    ['trust', '信任', 'relationship', 30, '依可靠行为、坦诚与背叛改变；变化速度符合人物经历。'],
    ['guard', '戒备', 'relationship', 30, '对另一方的防备程度；尊重边界可能降低戒备。'],
    ['mood', '心情', 'mind', 50, '低值表示低落，高值表示愉快；用描述说明混合情绪。'],
    ['tension', '紧张', 'mind', 20, '依据压力、危险、期待和人设变化，放松需要情境依据。'],
    ['energy', '体力', 'body', 70, '依据活动、休息与身体设定变化，不能每轮自动回满。'],
    ['fatigue', '疲劳', 'body', 20, '依据活动和剧情经过的时间累积，休息才有恢复依据。'],
    ['hunger', '饥饿', 'body', 20, '依据饮食和剧情时间变化；角色不需要进食时保持适用状态。'],
    ['thirst', '口渴', 'body', 20, '依据饮水、活动和剧情时间变化。'],
    ['pain', '疼痛', 'body', 0, '依据明确伤情、活动与恢复变化；没有证据不凭空增加伤病。'],
    ['desire', '欲望', 'physiology', 10, '依关系、情境、疲劳、情绪及人物设定判断，不等同于行动意愿。'],
    ['arousal', '兴奋', 'physiology', 0, '当前生理唤起程度，随实际互动变化，不等同于好感或同意。'],
    ['sensitivity', '敏感程度', 'physiology', 40, '结合身体设定和当前状况判断；不因每次对话机械上升。'],
];

export function defaultState() {
    const metrics = catalog.map(([id, label, group, value, rule]) => ({
        id, label, group, min: 0, max: 100, value, rule,
        description: '等待结合人物与剧情初始化', tendency: '', reason: '', delta: 0,
    }));
    return { actors: { char: clone(metrics), user: clone(metrics) }, summary: '' };
}

export function defaultSettings() {
    return {
        enabled: false, apiUrl: '', apiKey: '', model: '', timeout: 90,
        maxTokens: 6000, contextMessages: 24, maxContextChars: 100000,
        template: defaultState(), characterTemplates: {},
    };
}

function string(value, limit, field, optional = false) {
    if (optional && value == null) return '';
    if (typeof value !== 'string' || value.length > limit || (!optional && !value.trim())) {
        throw new Error(`${field}需要填写文字，且不能超过 ${limit} 个字符`);
    }
    return value.trim();
}

export function validateState(input) {
    if (!input || typeof input !== 'object' || !input.actors) throw new Error('状态格式不正确');
    const state = { actors: {}, summary: string(input.summary ?? '', 1600, '场景概况', true) };
    for (const actor of ACTORS) {
        const list = input.actors[actor];
        if (!Array.isArray(list) || list.length > 48) throw new Error(`${actor} 的指标必须是列表，最多 48 项`);
        const ids = new Set();
        state.actors[actor] = list.map(metric => {
            const id = string(metric.id, 64, '指标 ID');
            if (!/^[a-zA-Z][\w-]*$/.test(id) || ids.has(id)) throw new Error(`${actor} 的指标 ID 重复或格式错误：${id}`);
            ids.add(id);
            if (!Object.hasOwn(GROUPS, metric.group)) throw new Error(`指标 ${id} 的分组不正确`);
            const { min, max, value } = metric;
            if (![min, max, value].every(Number.isFinite) || min >= max || value < min || value > max) {
                throw new Error(`${metric.label || id} 的上下限或当前值不正确`);
            }
            return {
                id, label: string(metric.label, 50, '指标名称'), group: metric.group,
                min, max, value, rule: string(metric.rule ?? '', 1200, '变化规则', true),
                tendency: string(metric.tendency ?? '', 600, '人物倾向', true),
                description: string(metric.description ?? '', 600, '当前表现', true),
                reason: string(metric.reason ?? '', 600, '变化原因', true),
                delta: Number.isFinite(metric.delta) ? metric.delta : 0,
            };
        });
    }
    if (!state.actors.char.length && !state.actors.user.length) throw new Error('至少保留一项状态指标');
    return state;
}

export function sanitizeSettings(value = {}) {
    const defaults = defaultSettings();
    const settings = { ...defaults, ...value };
    for (const field of ['apiUrl', 'apiKey', 'model']) settings[field] = typeof value[field] === 'string' ? value[field] : '';
    settings.enabled = value.enabled === true;
    for (const [key, min, max] of [['timeout', 10, 600], ['maxTokens', 1000, 32000], ['contextMessages', 2, 500], ['maxContextChars', 10000, 1000000]]) {
        settings[key] = Number.isFinite(Number(settings[key])) ? Math.max(min, Math.min(max, Math.round(Number(settings[key])))) : defaults[key];
    }
    try { settings.template = validateState(settings.template); } catch { settings.template = defaults.template; }
    settings.characterTemplates = Object.fromEntries(Object.entries(value.characterTemplates ?? {}).flatMap(([key, state]) => {
        try { return [[key, validateState(state)]]; } catch { return []; }
    }));
    return settings;
}

// Content identity, not a security primitive. Includes the whole preceding branch;
// message extras and swipe indices are excluded because the visible text owns state.
function hash(text) {
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193);
        b = Math.imul(b ^ c, 0x85ebca6b);
    }
    return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function messageText(message) { return String(message?.mes ?? ''); }

export function prefixes(chat) {
    const path = ['duet-v1'];
    for (const message of chat) {
        path.push(hash(JSON.stringify([path.at(-1), !!message.is_user, !!message.is_system, message.name ?? '', messageText(message)])));
    }
    return path;
}

export function newStore() { return { version: 1, points: [] }; }

export function getStore(value) {
    if (!value) return newStore();
    if (value.version !== 1 || !Array.isArray(value.points)) throw new Error('此聊天的双向状态记录格式不兼容，未覆盖原记录');
    return value;
}

export function findPoint(store, chat) {
    const path = prefixes(chat);
    let best = null;
    for (const point of store.points) {
        if (Number.isInteger(point.count) && point.count >= 0 && point.count <= chat.length && point.hash === path[point.count]) {
            if (!best || point.count >= best.count) best = point;
        }
    }
    return best;
}

export function putPoint(store, chat, state, phase) {
    const point = { count: chat.length, hash: prefixes(chat).at(-1), state: validateState(state), phase, at: new Date().toISOString() };
    const next = clone(store);
    // One effective snapshot per exact branch position. Other swipes stay restorable.
    next.points = next.points.filter(p => !(p.count === point.count && p.hash === point.hash));
    next.points.push(point);
    return next;
}

export function parseResponse(content) {
    if (typeof content !== 'string') throw new Error('状态 API 没有返回文字');
    const raw = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let result;
    try { result = JSON.parse(raw); } catch { throw new Error('状态 API 返回的内容不是完整 JSON，原状态未变'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('状态 API 返回格式不正确');
    return result;
}

export function applyJudgment(previous, result, phase) {
    const next = clone(previous);
    next.summary = string(result.summary, 1600, 'API 场景概况', true);
    for (const actor of ACTORS) {
        const updates = result.actors?.[actor];
        if (!Array.isArray(updates) || updates.length !== previous.actors[actor].length) throw new Error(`API 没有完整返回 ${actor} 的指标，原状态未变`);
        const map = new Map();
        for (const update of updates) {
            if (!update || map.has(update.id)) throw new Error('API 返回了重复或无效指标');
            map.set(update.id, update);
        }
        next.actors[actor] = previous.actors[actor].map(metric => {
            const update = map.get(metric.id);
            if (!update || !Number.isFinite(update.value) || update.value < metric.min || update.value > metric.max) {
                throw new Error(`API 返回的 ${actor} / ${metric.label} 缺失或越界，原状态未变`);
            }
            return {
                ...metric, value: update.value,
                description: string(update.description, 600, 'API 当前表现'),
                reason: string(update.reason, 600, 'API 变化原因'),
                tendency: phase === 'init' ? string(update.tendency ?? metric.tendency, 600, '人物倾向', true) : metric.tendency,
                delta: phase === 'init' ? 0 : Math.round((update.value - metric.value) * 100) / 100,
            };
        });
        const additions = result.additions?.[actor] ?? [];
        if (!Array.isArray(additions) || additions.length > 6 || (phase !== 'init' && additions.length)) throw new Error('API 只能在初始化时补充少量人物专属指标');
        for (const item of additions) next.actors[actor].push({ ...item, delta: 0 });
    }
    return validateState(next);
}

export function renderPrompt(state, names) {
    if (!state) return '';
    const lines = [
        '[双向状态：当前剧情依据]',
        '以下是虚构角色的当前状态。结合人设和情境自然演绎双方的感受、身体反应和行为，不要在正文机械播报数值。',
        '用户本轮明确写出的感受、动作、决定和自我状态优先于历史数值及自动推演；补充未写出的反应，不覆盖明确输入。',
        '状态是倾向，不强制触发行为。欲望、身体反应、好感与意愿分别判断，不用其中一个替代另一个。',
    ];
    if (state.summary) lines.push(`场景概况：${state.summary}`);
    for (const actor of ACTORS) {
        lines.push(`${actor === 'char' ? '角色' : '用户角色'}：${names[actor] || actor}（关系指标指向另一方）`);
        for (const metric of state.actors[actor]) {
            lines.push(`${GROUPS[metric.group]} / ${metric.label}：${metric.value}（${metric.min}–${metric.max}）；${metric.description}${metric.tendency ? `；人物倾向：${metric.tendency}` : ''}${metric.rule ? `；规则：${metric.rule}` : ''}`);
        }
    }
    lines.push('[/双向状态]');
    return lines.join('\n');
}
