import { KEY, clone, getStore, findPoint, putPoint, prefixes, validateState, applyJudgment, renderPrompt, sanitizeSettings } from './model.js';
import { configured } from './api.js';

const ignored = type => ['quiet', 'impersonate'].includes(type);
const aborted = () => new DOMException('聊天或请求已变化', 'AbortError');

export class StateController {
    constructor(settings, host, onChange = () => {}) {
        this.settings = settings;
        this.host = host;
        this.onChange = onChange;
        this.queue = Promise.resolve();
        this.epoch = 0;
        this.busy = false;
        this.generating = false;
        this.status = '';
        this.statusKind = 'info';
        this.pending = null;
        this.preview = null;
    }

    active() { const ctx = this.host.capture(); return ctx?.key && !ctx.group ? ctx : null; }
    store(ctx) { return getStore(ctx.metadata[KEY]); }
    point(ctx) { return findPoint(this.store(ctx), ctx.chat); }
    template(ctx) { return clone(this.settings.characterTemplates[ctx.characterKey] ?? this.settings.template); }

    view() {
        const ctx = this.active();
        let point, state, unfinishedContinuation = false, formatError = '';
        try {
            point = ctx ? this.point(ctx) : null;
            const carry = ctx ? this.continuation(this.store(ctx), ctx.chat) : null;
            if (carry && point?.count !== ctx.chat.length) {
                point = carry.basePoint;
                unfinishedContinuation = true;
            }
            const candidate = ctx && this.preview?.key === ctx.key ? this.preview.state : point?.state;
            state = candidate ? validateState(candidate) : undefined;
        } catch (error) { formatError = error.message; }
        return {
            settings: this.settings, key: ctx?.key ?? '', characterKey: ctx?.characterKey ?? '',
            names: ctx?.profile.names ?? { char: 'char', user: 'user' },
            state, phase: point?.phase, updatedAt: point?.at,
            busy: this.busy, generating: this.generating,
            pendingCount: ctx && point ? Math.max(unfinishedContinuation ? 1 : 0, ctx.chat.length - point.count) : 0,
            status: formatError || this.status || (!this.settings.enabled ? '尚未启用' : !configured(this.settings) ? '请配置独立 API' : !ctx ? '请选择一对一聊天' : '准备就绪'),
            statusKind: formatError ? 'error' : this.statusKind,
        };
    }

    publish() { this.onChange(this.view()); }
    message(text, kind = 'info') { this.status = text; this.statusKind = kind; this.publish(); }
    inject(state, ctx = this.active()) { this.host.inject(this.settings.enabled && ctx ? renderPrompt(state, ctx.profile.names) : ''); }

    enqueue(task, epoch = this.epoch) {
        const result = this.queue.catch(() => {}).then(() => {
            if (epoch !== this.epoch) throw aborted();
            return task();
        });
        this.queue = result.catch(() => {});
        return result;
    }

    invalidate() {
        this.epoch++;
        clearTimeout(this.historyTimer);
        this.request?.abort();
        this.pending = null;
        this.preview = null;
    }

    async switchChat() {
        const owner = this.active();
        if (owner && this.ownerKey === owner.key && this.ownerMetadata === owner.metadata) {
            this.publish();
            return this.busy ? this.queue : this.sync();
        }
        this.invalidate();
        this.ownerKey = owner?.key;
        this.ownerMetadata = owner?.metadata;
        this.generating = false;
        this.host.inject('');
        this.status = '';
        this.statusKind = 'info';
        this.publish();
        return this.sync();
    }

    assertCurrent(ctx, epoch, expectedHash) {
        const now = this.active();
        if (epoch !== this.epoch || !now || now.key !== ctx.key || now.metadata !== ctx.metadata || prefixes(now.chat).at(-1) !== expectedHash) throw aborted();
    }

    async evaluate(ctx, target, phase, { basePoint, events, history } = {}) {
        const epoch = this.epoch;
        const expectedHash = prefixes(ctx.chat).at(-1);
        const point = basePoint ?? findPoint(this.store(ctx), target);
        const actualPhase = point ? phase : 'init';
        const state = point ? validateState(point.state) : this.template(ctx);
        const background = history ?? (point ? target.slice(0, point.count) : target);
        const changes = events ?? (point ? target.slice(point.count) : []);
        this.request = new AbortController();
        this.busy = true;
        this.message(actualPhase === 'init' ? '正在根据人物与剧情生成初始状态…' : phase === 'pre' ? '正在判断本轮输入…' : '正在结算新增剧情…');
        try {
            const result = await this.host.judge({ phase: actualPhase, state, history: background, events: changes, profile: ctx.profile }, this.settings, this.request.signal);
            this.assertCurrent(ctx, epoch, expectedHash);
            const nextState = applyJudgment(state, result, actualPhase);
            const nextStore = putPoint(this.store(ctx), target, nextState, actualPhase);
            if (this.continuation(this.store(ctx), target)) delete nextStore.continuation;
            await this.commit(ctx, nextStore);
            this.assertCurrent(ctx, epoch, expectedHash);
            this.inject(nextState, ctx);
            this.message(actualPhase === 'init' ? '初始状态已生成，可随时修改' : phase === 'pre' ? '输入已结算，等待角色回复' : '状态已随剧情更新', 'success');
            return findPoint(nextStore, target);
        } finally {
            this.busy = false;
            this.request = null;
            this.publish();
        }
    }

    async ensure(ctx, target, phase) {
        const point = findPoint(this.store(ctx), target);
        if (point?.count === target.length) { this.inject(point.state, ctx); return point; }
        const continuation = this.continuation(this.store(ctx), target);
        if (continuation) return this.evaluate(ctx, target, phase, continuation);
        return this.evaluate(ctx, target, phase);
    }

    continuation(store, target) {
        const saved = store.continuation;
        if (!saved || !Number.isInteger(saved.count) || saved.count < 1 || target.length < saved.count || typeof saved.text !== 'string') return null;
        const current = target[saved.count - 1];
        if (current.is_user || typeof current.mes !== 'string' || !current.mes.startsWith(saved.text) || current.mes === saved.text) return null;
        if (prefixes(target.slice(0, saved.count - 1)).at(-1) !== saved.prefix) return null;
        const history = clone(target.slice(0, saved.count));
        history.at(-1).mes = saved.text;
        return { basePoint: saved.point, history, events: [{ ...current, mes: current.mes.slice(saved.text.length) }, ...target.slice(saved.count)] };
    }

    async commit(ctx, nextStore) {
        const previous = ctx.metadata[KEY];
        ctx.metadata[KEY] = nextStore;
        try { await this.host.save(ctx); }
        catch (error) {
            if (ctx.metadata[KEY] === nextStore) {
                if (previous) ctx.metadata[KEY] = previous;
                else delete ctx.metadata[KEY];
            }
            throw error;
        }
    }

    async sync(phase = 'reconcile') {
        return this.enqueue(async () => {
            const ctx = this.active();
            if (!this.settings.enabled || !configured(this.settings) || !ctx || this.generating) { this.publish(); return; }
            // During native startup the selected character exists before chat loading
            // finishes. Wait for CHAT_CHANGED/first message instead of initializing
            // an empty transient chat and paying for a second initialization.
            if (!ctx.chat.length) { this.message('等待聊天内容载入；首次发言时会自动初始化'); return; }
            const last = ctx.chat.at(-1);
            if (last && !last.is_user && (!String(last.mes ?? '').trim() || (last.swipes && last.swipe_id >= last.swipes.length))) return;
            await this.ensure(ctx, clone(ctx.chat), phase);
            this.statusKind = 'success';
            this.status = '状态与当前聊天一致';
            this.publish();
        }).catch(error => { this.report(error); });
    }

    start(type, dryRun = false) {
        if (dryRun) return;
        clearTimeout(this.historyTimer);
        if (ignored(type) || !this.settings.enabled || !this.active()) { this.host.inject(''); return; }
        this.stopped = false;
        this.generating = true;
        this.publish();
    }

    async before(type, abort) {
        if (ignored(type) || !this.settings.enabled || !this.active()) { this.host.inject(''); return; }
        try {
            await this.enqueue(async () => {
                const ctx = this.active();
                if (!ctx) throw aborted();
                if (!configured(this.settings)) throw new Error('请先填写独立 API 地址和模型；本轮生成已暂停');
                const target = clone(ctx.chat);
                if (type === 'swipe' && target.length && !target.at(-1).is_user) target.pop();
                const point = await this.ensure(ctx, target, 'pre');
                if (type === 'continue' && target.length && !target.at(-1).is_user) {
                    const next = clone(this.store(ctx));
                    next.continuation = { count: target.length, prefix: prefixes(target.slice(0, -1)).at(-1), text: target.at(-1).mes, point: clone(point) };
                    await this.commit(ctx, next);
                }
                this.generating = true;
                this.pending = { key: ctx.key, epoch: this.epoch, type, point: clone(point), history: target };
                this.preview = { key: ctx.key, state: point.state };
                this.inject(point.state, ctx);
                this.publish();
            });
        } catch (error) {
            this.generating = false;
            this.pending = null;
            this.preview = null;
            this.host.inject('');
            abort(true);
            this.report(error, '回复前判定未完成，本轮生成已暂停。');
        }
    }

    async after(type) {
        if (this.stopped || ignored(type) || !this.settings.enabled || !configured(this.settings) || !this.active()) return;
        return this.enqueue(async () => {
            const ctx = this.active();
            const target = clone(ctx.chat);
            if (!target.length || target.at(-1).is_user || !String(target.at(-1).mes ?? '').trim()) return;
            const pending = this.pending;
            this.preview = null;
            // Continuation rewrites the last message in place. Use its already-accounted
            // prefix as baseline and settle just the newly appended text.
            if (pending?.key === ctx.key && pending.epoch === this.epoch && pending.type === 'continue' && pending.history.length === target.length) {
                const old = pending.history.at(-1), current = target.at(-1);
                if (prefixes(pending.history.slice(0, -1)).at(-1) === prefixes(target.slice(0, -1)).at(-1) && current.mes.startsWith(old.mes)) {
                    const suffix = current.mes.slice(old.mes.length);
                    if (suffix.trim()) await this.evaluate(ctx, target, 'post', { basePoint: pending.point, history: pending.history, events: [{ ...current, mes: suffix }] });
                    else this.inject(pending.point.state, ctx);
                    this.pending = null;
                    return;
                }
            }
            await this.ensure(ctx, target, 'post');
            this.pending = null;
        }).catch(error => this.report(error, '回复已生成，但状态尚未结算；可点“同步状态”重试。')).finally(() => {
            this.generating = false;
            this.preview = null;
            this.publish();
        });
    }

    ended() { this.generating = false; this.publish(); }

    stop() {
        this.invalidate();
        this.stopped = true;
        this.generating = false;
        this.host.inject('');
        this.message('生成已停止；保留已确认状态，未结算的内容可同步后恢复');
    }

    historyChanged() {
        if (this.generating) { this.publish(); return; }
        this.invalidate();
        const ctx = this.active();
        try { this.inject(ctx ? this.point(ctx)?.state : null); } catch { this.host.inject(''); }
        this.status = '已按当前消息恢复状态';
        this.publish();
        this.historyTimer = setTimeout(() => { void this.sync(); }, 80);
    }

    report(error, prefix = '') {
        if (error.name === 'AbortError') return;
        this.message(`${prefix}${error.message || '操作未完成'}`, 'error');
        this.host.notify?.(this.status);
    }

    async updateSettings(value) {
        this.invalidate();
        this.settings = sanitizeSettings({ ...this.settings, ...value });
        await this.host.saveSettings(this.settings);
        this.host.inject('');
        this.status = this.settings.enabled ? '配置已保存' : '插件已停用';
        this.statusKind = 'info';
        this.publish();
        return this.sync();
    }

    async test(settings) {
        return this.enqueue(async () => {
            this.busy = true;
            this.request = new AbortController();
            this.message('正在测试独立 API 的连接和 JSON 输出…');
            try {
                await this.host.test(sanitizeSettings({ ...this.settings, ...settings }), this.request.signal);
                this.message('连接与 JSON 输出测试成功；点击“保存设置”后应用', 'success');
            } finally { this.busy = false; this.request = null; this.publish(); }
        });
    }

    async saveEditor(scope, state, ownerKey) {
        const next = validateState(state);
        if (this.busy || this.generating) throw new Error('请等待当前生成和状态结算完成');
        const ctx = this.active();
        if (scope !== 'default' && (!ctx || ctx.key !== ownerKey)) throw new Error('聊天已切换，请重新打开编辑器');
        if (scope === 'current') {
            const point = this.point(ctx);
            if (!point || point.count !== ctx.chat.length) throw new Error('请先同步未结算的剧情，再修改当前状态');
            for (const actor of ['char', 'user']) {
                for (const metric of next.actors[actor]) {
                    metric.delta = metric.value - (point.state.actors[actor].find(m => m.id === metric.id)?.value ?? metric.value);
                    metric.reason = '用户手动修改，以此作为后续判断依据';
                }
            }
            await this.commit(ctx, putPoint(this.store(ctx), ctx.chat, next, 'manual'));
            this.inject(next, ctx);
        } else {
            if (scope === 'default') this.settings.template = next;
            else this.settings.characterTemplates[ctx.characterKey] = next;
            await this.host.saveSettings(this.settings);
        }
        this.message(scope === 'current' ? '手动修改已生效，后续判断采用新状态' : '模板已保存，之后初始化的聊天会采用它', 'success');
    }
}
