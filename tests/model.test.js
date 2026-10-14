import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, defaultSettings, validateState, putPoint, newStore, findPoint, applyJudgment, renderPrompt, parseResponse, sanitizeSettings } from '../src/model.js';
import { buildMessages, requestJson, normalizeUrl } from '../src/api.js';

export function answer(state, step = 0) {
    return {
        summary: '测试场景：两位成年角色正在交谈。',
        actors: Object.fromEntries(['char', 'user'].map(actor => [actor, state.actors[actor].map(m => ({
            id: m.id, value: Math.max(m.min, Math.min(m.max, m.value + step)),
            description: '合成测试状态', reason: step ? '本次合成事件造成变化' : '没有新的变化依据', tendency: '保留独立人物倾向',
        }))])),
    };
}

test('directions and actor values remain independent; input precedence reaches main prompt', () => {
    const state = defaultState();
    state.actors.char[0].value = 81;
    state.actors.user[0].value = 22;
    const prompt = renderPrompt(state, { char: '林舟', user: '阿宁' });
    assert.match(prompt, /81/); assert.match(prompt, /22/);
    assert.match(prompt, /用户本轮明确写出的/);
    assert.match(prompt, /不覆盖明确输入/);
    assert.match(prompt, /用户角色：阿宁/);
});

test('history restores both swipes and invalidates all following points on earlier edit', () => {
    const chat = [{ is_user: false, mes: 'hello' }, { is_user: true, mes: 'input' }];
    const a = [...chat, { is_user: false, mes: 'reply A' }];
    const b = [...chat, { is_user: false, mes: 'reply B' }];
    let store = putPoint(newStore(), chat, defaultState(), 'pre');
    const sa = defaultState(); sa.actors.char[0].value = 70;
    const sb = defaultState(); sb.actors.char[0].value = 20;
    store = putPoint(store, a, sa, 'post');
    store = putPoint(store, b, sb, 'post');
    assert.equal(findPoint(store, a).state.actors.char[0].value, 70);
    assert.equal(findPoint(store, b).state.actors.char[0].value, 20);
    assert.equal(findPoint(store, chat).phase, 'pre');
    assert.equal(findPoint(store, [{ ...chat[0], mes: 'edited' }, ...a.slice(1)]), null);
    const reloaded = JSON.parse(JSON.stringify(store));
    assert.deepEqual(findPoint(reloaded, a), findPoint(store, a));
});

test('invalid or incomplete API results never partially mutate state', () => {
    const state = defaultState(), before = JSON.stringify(state);
    const result = answer(state, 5);
    result.actors.user.pop();
    assert.throws(() => applyJudgment(state, result, 'post'), /完整返回/);
    assert.equal(JSON.stringify(state), before);
    const outOfRange = answer(state); outOfRange.actors.char[0].value = 999;
    assert.throws(() => applyJudgment(state, outOfRange, 'pre'), /越界/);
    const duplicate = answer(state); duplicate.actors.char[1].id = duplicate.actors.char[0].id;
    assert.throws(() => applyJudgment(state, duplicate, 'pre'), /重复/);
});

test('initialization supports personal metrics, later responses cannot rewrite definitions', () => {
    const state = defaultState(), result = answer(state, 4);
    result.additions = { char: [{ ...state.actors.char[0], id: 'loyalty', label: '忠诚' }] };
    const next = applyJudgment(state, result, 'init');
    assert.equal(next.actors.char.at(-1).label, '忠诚');
    assert.equal(next.actors.char[0].delta, 0);
    assert.equal(next.actors.char[0].tendency, '保留独立人物倾向');
    assert.throws(() => applyJudgment(state, result, 'post'), /初始化/);
});

test('template validation rejects bad ranges, duplicate IDs, and unlimited metrics', () => {
    const state = defaultState(); state.actors.char[0].max = -1;
    assert.throws(() => validateState(state), /上下限/);
    assert.equal(sanitizeSettings({ template: state }).template.actors.char[0].max, 100);
});

test('context keeps pending events whole, separates background, and rejects overflow', () => {
    const settings = defaultSettings(); settings.contextMessages = 2;
    const history = Array.from({ length: 6 }, (_, i) => ({ is_user: true, mes: `old-${i}` }));
    const events = [{ is_user: true, mes: 'new-input', extra: { reasoning: 'DO_NOT_INCLUDE' } }];
    const input = { phase: 'pre', state: defaultState(), history, events, profile: { names: {}, character: {}, persona: '' } };
    const messages = buildMessages(input, settings), body = JSON.parse(messages[1].content);
    assert.equal(body.history.length, 2); assert.equal(body.newEvents[0].text, 'new-input');
    assert.ok(!messages[1].content.includes('DO_NOT_INCLUDE'));
    assert.throws(() => buildMessages(input, { ...settings, maxContextChars: 10 }), /未截断/);
});

test('API uses only explicit independent settings and normalizes completion endpoint', async () => {
    let sent;
    const settings = { ...defaultSettings(), apiUrl: 'https://state.invalid/v1/chat/completions/', model: 'state-model', apiKey: 'test-not-a-real-key' };
    const result = await requestJson(settings, [{ role: 'user', content: 'test' }], {
        headers: { 'x-csrf-token': 'fixture' }, fetcher: async (url, options) => {
            sent = { url, ...options, body: JSON.parse(options.body) };
            return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }) };
        },
    });
    assert.equal(result.ok, true);
    assert.equal(sent.body.reverse_proxy, 'https://state.invalid/v1');
    assert.equal(sent.body.proxy_password, 'test-not-a-real-key');
    assert.equal(sent.body.model, 'state-model');
    assert.equal(sent.body.stream, false);
    assert.ok(!Object.hasOwn(sent.body, 'secret_id'));
    assert.throws(() => normalizeUrl('javascript:alert(1)'), /HTTP/);
    assert.throws(() => normalizeUrl('https://example.com/v1?key=bad'), /密钥/);
});

test('API rejects truncated, empty and non-JSON results, without reflecting credentials', async () => {
    const settings = { ...defaultSettings(), apiUrl: 'https://fixture.invalid/v1', model: 'fixture' };
    const cases = [
        [{ ok: false, status: 401, text: async () => 'SECRET' }, /HTTP 401/],
        [{ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }) }, /截断/],
        [{ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) }, /有效正文/],
    ];
    for (const [response, expected] of cases) await assert.rejects(requestJson(settings, [], { fetcher: async () => response }), expected);
    assert.throws(() => parseResponse('not json'), /完整 JSON/);
    assert.deepEqual(parseResponse('```json\n{"a":1}\n```'), { a: 1 });
});

test('independent request honors cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(requestJson({ ...defaultSettings(), apiUrl: 'http://localhost:9999/v1', model: 'fixture' }, [], {
        signal: controller.signal,
        fetcher: async (_url, options) => { if (options.signal.aborted) throw new DOMException('aborted', 'AbortError'); },
    }), { name: 'AbortError' });
});
