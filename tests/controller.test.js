import test from 'node:test';
import assert from 'node:assert/strict';
import { StateController } from '../src/controller.js';
import { KEY, clone, defaultSettings, findPoint } from '../src/model.js';

function result(state, step = 0) {
    return { summary: '合成测试场景', actors: Object.fromEntries(['char', 'user'].map(actor => [actor, state.actors[actor].map(m => ({
        id: m.id, value: Math.min(m.max, m.value + step), description: '合成表现', reason: '合成事件', tendency: '人物倾向',
    }))])) };
}
const user = text => ({ name: '阿宁', is_user: true, mes: text });
const char = text => ({ name: '林舟', is_user: false, mes: text });

function fixture() {
    let active = { key: 'a', characterKey: 'char-a', chat: [char('开场')], metadata: {}, profile: { names: { char: '林舟', user: '阿宁' }, character: {}, persona: '' } };
    const calls = [], errors = [], saved = [];
    let injected = '', implementation;
    const host = {
        capture: () => active,
        inject: text => { injected = text; },
        save: async ctx => { saved.push({ key: ctx.key, data: clone(ctx.metadata) }); },
        saveSettings: async () => {},
        notify: text => errors.push(text),
        judge: async (input, settings, signal) => {
            calls.push(clone(input));
            if (implementation) return implementation(input, signal);
            return result(input.state, input.phase === 'init' ? 0 : input.phase === 'pre' ? 2 : 3);
        },
    };
    const settings = { ...defaultSettings(), enabled: true, apiUrl: 'https://fixture.invalid/v1', model: 'fixture' };
    const controller = new StateController(settings, host);
    return { controller, host, calls, errors, saved, get active() { return active; }, get injected() { return injected; },
        setActive: value => { active = value; }, implementation: value => { implementation = value; } };
}

test('normal round settles input before main and only new reply after; duplicate events do not charge twice', async () => {
    const f = fixture(), c = f.controller;
    await c.switchChat();
    f.active.chat.push(user('我主动问候她'));
    c.start('normal');
    let aborts = 0;
    await c.before('normal', () => aborts++);
    assert.match(f.injected, /好感：32/);
    assert.deepEqual(f.calls.at(-1).events.map(m => m.mes), ['我主动问候她']);
    f.active.chat.push(char('她微笑着回应'));
    await c.after('normal');
    assert.deepEqual(f.calls.at(-1).events.map(m => m.mes), ['她微笑着回应']);
    assert.equal(findPoint(f.active.metadata[KEY], f.active.chat).state.actors.char[0].value, 35);
    await c.after('normal');
    assert.equal(f.calls.length, 3);
    assert.equal(aborts, 0);
});

test('regenerate reuses input checkpoint and does not accumulate previous reply', async () => {
    const f = fixture(), c = f.controller;
    await c.switchChat();
    f.active.chat.push(user('输入'));
    c.start('normal'); await c.before('normal', assert.fail);
    f.active.chat.push(char('旧回复')); await c.after('normal');
    c.start('regenerate'); f.active.chat.pop(); c.historyChanged();
    await c.before('regenerate', assert.fail);
    assert.equal(f.calls.length, 3);
    assert.match(f.injected, /好感：32/);
    f.active.chat.push(char('新回复')); await c.after('regenerate');
    assert.equal(c.view().state.actors.char[0].value, 35);
    assert.equal(f.calls.length, 4);
});

test('swipe evaluates from pre-reply state, retains old branch, and deletion restores', async () => {
    const f = fixture(), c = f.controller;
    await c.switchChat(); f.active.chat.push(user('输入'));
    c.start('normal'); await c.before('normal', assert.fail);
    f.active.chat.push(char('回复A')); await c.after('normal');
    c.start('swipe'); await c.before('swipe', assert.fail);
    assert.match(f.injected, /好感：32/);
    f.implementation(input => result(input.state, 7));
    f.active.chat.at(-1).mes = '回复B'; await c.after('swipe');
    assert.equal(c.view().state.actors.char[0].value, 39);
    f.active.chat.at(-1).mes = '回复A'; await c.sync();
    assert.equal(c.view().state.actors.char[0].value, 35);
    f.active.chat.pop(); await c.sync();
    assert.equal(c.view().state.actors.char[0].value, 32);
});

test('continuation settles only appended fragment from existing reply state', async () => {
    const f = fixture(), c = f.controller;
    await c.switchChat();
    c.start('continue'); await c.before('continue', assert.fail);
    f.active.chat[0].mes += '。续写内容';
    await c.after('continue');
    assert.deepEqual(f.calls.at(-1).events.map(m => m.mes), ['。续写内容']);
    assert.equal(c.view().state.actors.char[0].value, 33);
});

test('manual edits become next input baseline and survive reload', async () => {
    const f = fixture(), c = f.controller;
    await c.switchChat();
    const state = clone(c.view().state); state.actors.char[0].value = 81; state.actors.user[0].value = 17;
    await c.saveEditor('current', state, 'a');
    f.active.metadata = JSON.parse(JSON.stringify(f.active.metadata));
    await c.switchChat();
    f.active.chat.push(user('继续交谈'));
    c.start('normal'); await c.before('normal', assert.fail);
    assert.equal(f.calls.at(-1).state.actors.char[0].value, 81);
    assert.equal(f.calls.at(-1).state.actors.user[0].value, 17);
});

test('history edit replays changed suffix; existing past snapshots remain intact', async () => {
    const f = fixture(), c = f.controller;
    await c.switchChat();
    f.active.chat.push(user('旧输入')); c.start('normal'); await c.before('normal', assert.fail);
    f.active.chat.push(char('回应')); await c.after('normal');
    f.active.chat[1].mes = '修改后的输入'; await c.sync();
    assert.equal(f.calls.at(-1).phase, 'reconcile');
    assert.deepEqual(f.calls.at(-1).events.map(m => m.mes), ['修改后的输入', '回应']);
});

test('pre failure pauses generation and preserves the old state; retry works', async () => {
    const f = fixture(), c = f.controller; await c.switchChat();
    const before = JSON.stringify(f.active.metadata);
    f.active.chat.push(user('新输入')); f.implementation(() => { throw new Error('fixture outage'); });
    let aborted = false; c.start('normal'); await c.before('normal', immediate => { aborted = immediate; });
    assert.equal(aborted, true); assert.equal(JSON.stringify(f.active.metadata), before); assert.equal(f.injected, '');
    assert.match(c.view().status, /fixture outage/);
    f.implementation(null); c.start('regenerate'); await c.before('regenerate', assert.fail);
    assert.equal(c.view().state.actors.char[0].value, 32);
});

test('post failure retains pre state, then catch-up settles missing reply once', async () => {
    const f = fixture(), c = f.controller; await c.switchChat();
    f.active.chat.push(user('输入')); c.start('normal'); await c.before('normal', assert.fail);
    f.active.chat.push(char('回复')); f.implementation(() => { throw new Error('post outage'); });
    await c.after('normal'); assert.equal(c.view().state.actors.char[0].value, 32);
    assert.equal(c.view().pendingCount, 1);
    f.implementation(null); await c.sync(); assert.equal(c.view().state.actors.char[0].value, 35);
    assert.deepEqual(f.calls.at(-1).events.map(m => m.mes), ['回复']);
});

test('late API response cannot write to another chat or inject its state', async () => {
    const f = fixture(), c = f.controller; await c.switchChat();
    let resolve, entered;
    const ready = new Promise(r => { entered = r; });
    f.implementation(input => new Promise(r => { resolve = () => r(result(input.state, 5)); entered(); }));
    const a = f.active; a.chat.push(user('slow'));
    c.start('normal'); let aborted = false;
    const pre = c.before('normal', () => { aborted = true; }); await ready;
    const b = { ...a, key: 'b', chat: [char('另一个聊天')], metadata: {} }; f.setActive(b);
    f.implementation(null); const switching = c.switchChat(); resolve(); await pre; await switching;
    assert.equal(aborted, true);
    assert.equal(a.metadata[KEY].points.length, 1);
    assert.equal(b.metadata[KEY].points.length, 1);
    assert.equal(c.view().state.actors.char[0].value, 30);
});

test('stop cancels pending work and does not start new settlement on a partial reply event', async () => {
    const f = fixture(), c = f.controller; await c.switchChat();
    c.start('normal'); c.stop();
    f.active.chat.push(char('partial'));
    await c.after('normal'); assert.equal(f.calls.length, 1);
    await c.sync(); assert.equal(f.calls.length, 2);
});

test('quiet, impersonation, dry-run, disabled and group chats make no state requests', async () => {
    const f = fixture(), c = f.controller;
    for (const type of ['quiet', 'impersonate']) { c.start(type); await c.before(type, assert.fail); await c.after(type); }
    c.start('normal', true); assert.equal(f.calls.length, 0);
    c.settings.enabled = false; await c.switchChat(); await c.before('normal', assert.fail);
    c.settings.enabled = true; f.active.group = true; await c.switchChat(); await c.before('normal', assert.fail);
    assert.equal(f.calls.length, 0); assert.equal(f.injected, '');
});

test('character template only affects fresh chats and keeps user and char rules', async () => {
    const f = fixture(), c = f.controller; await c.switchChat();
    const template = clone(c.settings.template); template.actors.char[0].value = 60; template.actors.user[0].value = 12;
    await c.saveEditor('character', template, 'a');
    assert.equal(c.view().state.actors.char[0].value, 30);
    f.setActive({ ...f.active, key: 'new-chat', chat: [char('新的开场')], metadata: {} }); await c.switchChat();
    assert.equal(c.view().state.actors.char[0].value, 60);
    assert.equal(c.view().state.actors.user[0].value, 12);
});

test('missing config blocks main generation instead of silently using main API', async () => {
    const f = fixture(), c = f.controller; c.settings.apiUrl = '';
    c.start('normal'); let stopped = false; await c.before('normal', () => { stopped = true; });
    assert.equal(stopped, true); assert.equal(f.calls.length, 0); assert.match(c.view().status, /独立 API/);
});

test('failed continuation survives page reload and settles only suffix, retaining manual baseline', async () => {
    const f = fixture(), c = f.controller; await c.switchChat();
    const state = clone(c.view().state); state.actors.char[0].value = 80;
    await c.saveEditor('current', state, 'a');
    c.start('continue'); await c.before('continue', assert.fail);
    f.active.chat[0].mes += '，新增片段';
    f.implementation(() => { throw new Error('outage'); }); await c.after('continue');
    assert.equal(c.view().state.actors.char[0].value, 80);
    assert.equal(c.view().pendingCount, 1);
    f.active.metadata = JSON.parse(JSON.stringify(f.active.metadata));
    f.implementation(null);
    const reloaded = new StateController(c.settings, f.host);
    await reloaded.switchChat();
    assert.equal(reloaded.view().state.actors.char[0].value, 83);
    assert.deepEqual(f.calls.at(-1).events.map(m => m.mes), ['，新增片段']);
    assert.equal(f.active.metadata[KEY].continuation, undefined);
});

test('failed persistence rolls back in-memory checkpoint and blocks generation', async () => {
    const f = fixture(), c = f.controller; await c.switchChat();
    const original = JSON.stringify(f.active.metadata);
    f.active.chat.push(user('输入'));
    f.host.save = async () => { throw new Error('persistence failed'); };
    let paused = false; c.start('normal'); await c.before('normal', () => { paused = true; });
    assert.equal(paused, true); assert.equal(JSON.stringify(f.active.metadata), original);
});

test('startup waits for chat content; repeated ready notifications do not duplicate initialization', async () => {
    const f = fixture(), c = f.controller;
    f.active.chat.length = 0; await c.switchChat(); assert.equal(f.calls.length, 0);
    f.active.chat.push(char('loaded greeting'));
    await c.switchChat(); await c.switchChat();
    assert.equal(f.calls.length, 1);
    assert.equal(c.view().state.actors.char[0].value, 30);
});

test('repeated notification for same loading chat does not cancel its in-flight judgment', async () => {
    const f = fixture(), c = f.controller;
    let resolve, entered;
    const ready = new Promise(r => { entered = r; });
    f.implementation(input => new Promise(r => { resolve = () => r(result(input.state)); entered(); }));
    const first = c.switchChat(); await ready;
    const second = c.switchChat(); resolve(); await first; await second;
    assert.equal(f.calls.length, 1); assert.equal(f.active.metadata[KEY].points.length, 1);
});
