import { ACTORS, GROUPS, clone, validateState } from './model.js';

function el(tag, className = '', text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}
function button(text, action, className = '') {
    const node = el('button', `ds-button ${className}`, text);
    node.type = 'button';
    if (action) node.addEventListener('click', action);
    return node;
}
function field(label, type = 'text', name = '') {
    const wrap = el('label', 'ds-field');
    const input = el(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.name = name;
    input.autocomplete = type === 'password' ? 'new-password' : 'off';
    wrap.append(el('span', '', label), input);
    return { wrap, input };
}

export function createUI(actions) {
    let view, panel, settingsPanel, body, status, badge, controls, settingsForm;
    let actor = 'char', signature = '', dialog, lastKey = '', editingScope;
    const inputs = {};
    const tabButtons = {};
    const reasonOpen = new Set();
    const busyControls = [];

    async function invoke(action) {
        try { return await action(); } catch (error) { actions.onError(error); }
    }

    function values() {
        const result = {};
        for (const [name, input] of Object.entries(inputs)) {
            result[name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value.trim();
        }
        return result;
    }

    function showSettings() {
        settingsPanel.open = true;
        // Native extensions settings may live in a closed drawer; a standalone dialog
        // presents the same real form so the panel's settings button always works.
        const popup = el('dialog', 'ds-dialog ds-settings-dialog');
        const head = el('header', 'ds-dialog-head');
        head.append(el('h3', '', '双向状态 · 设置'), button('关闭', () => popup.close()));
        const placeholder = document.createComment('duet-settings-form');
        settingsForm.before(placeholder);
        popup.append(head, settingsForm);
        document.body.append(popup);
        popup.addEventListener('close', () => { placeholder.replaceWith(settingsForm); popup.remove(); }, { once: true });
        popup.showModal();
    }

    function mountSettings() {
        const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
        if (!container || settingsPanel) return;
        settingsPanel = el('details', 'ds-settings');
        settingsPanel.id = 'duet-state-settings';
        settingsPanel.append(el('summary', '', '双向状态'));
        settingsForm = el('form', 'ds-settings-form');
        settingsForm.append(el('p', 'ds-muted', '一对一聊天的双方状态。独立 API 判断，主模型依据状态演绎；你的明确输入优先。'));
        const enabled = field('启用双向状态', 'checkbox', 'enabled');
        enabled.wrap.classList.add('ds-checkbox');
        inputs.enabled = enabled.input;
        settingsForm.append(enabled.wrap);
        const grid = el('div', 'ds-form-grid');
        for (const [name, label, type, placeholder] of [
            ['apiUrl', '独立 API 地址', 'url', 'https://example.com/v1'],
            ['model', '模型名称', 'text', '填写该接口支持的模型'],
            ['apiKey', '独立 API 密钥', 'password', '在这里填写；无需授权的本地服务可留空'],
        ]) {
            const item = field(label, type, name);
            item.input.placeholder = placeholder;
            inputs[name] = item.input;
            grid.append(item.wrap);
        }
        settingsForm.append(grid, el('p', 'ds-muted', '支持 OpenAI 兼容 Chat Completions 接口。密钥保存在酒馆当前用户的扩展设置中；不会读取主 API 配置。'));
        const advanced = el('details', 'ds-advanced');
        advanced.append(el('summary', '', '请求与上下文'));
        const advancedGrid = el('div', 'ds-form-grid');
        for (const [name, label, min, max] of [
            ['timeout', '超时（秒）', 10, 600], ['maxTokens', '最大输出 token', 1000, 32000],
            ['contextMessages', '最近背景消息数', 2, 500], ['maxContextChars', '判定内容上限（字符）', 10000, 1000000],
        ]) {
            const item = field(label, 'number', name);
            Object.assign(item.input, { min, max, step: 1 });
            inputs[name] = item.input;
            advancedGrid.append(item.wrap);
        }
        advanced.append(advancedGrid, el('p', 'ds-muted', '人物设定、当前状态与全部待结算事件会一并提供。上限不足时会提示，不静默丢弃待结算内容。'));
        settingsForm.append(advanced);
        const row = el('div', 'ds-actions');
        const save = button('保存设置', null, 'ds-primary');
        save.type = 'submit';
        const test = button('测试连接', () => invoke(() => actions.onTest(values())));
        row.append(save, test);
        busyControls.push(save, test);
        const templates = el('div', 'ds-actions');
        const defaultBtn = button('编辑默认模板', () => openEditor('default'));
        const charBtn = button('编辑此角色模板', () => openEditor('character'));
        charBtn.dataset.needsChat = 'true';
        templates.append(defaultBtn, charBtn);
        busyControls.push(defaultBtn, charBtn);
        settingsForm.append(row, templates, el('p', 'ds-muted', '模板影响之后初始化的聊天；面板中的“编辑状态”只修改当前聊天。首次启用并配置接口后自动初始化。'));
        const feedback = el('p', 'ds-status');
        feedback.dataset.settingsStatus = 'true';
        feedback.setAttribute('role', 'status');
        settingsForm.append(feedback);
        settingsForm.addEventListener('submit', event => { event.preventDefault(); void invoke(() => actions.onSettings(values())); });
        settingsPanel.append(settingsForm);
        container.append(settingsPanel);
    }

    function mountPanel() {
        const form = document.getElementById('form_sheld');
        if (!form || panel) return;
        panel = el('details', 'ds-panel');
        panel.id = 'duet-state-panel';
        const summary = el('summary', 'ds-panel-summary');
        badge = el('span', 'ds-badge', '尚未启用');
        summary.append(el('strong', '', '双向状态'), badge, el('span', 'ds-summary-hint', '展开 / 收起'));
        panel.append(summary);
        const content = el('div', 'ds-content');
        const top = el('div', 'ds-toolbar');
        const tabs = el('div', 'ds-tabs');
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', '查看双方状态');
        for (const key of ACTORS) {
            const tab = button(key, () => { actor = key; signature = ''; render(); });
            tab.setAttribute('role', 'tab');
            tab.dataset.actor = key;
            tabButtons[key] = tab;
            tabs.append(tab);
        }
        tabs.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            actor = event.key === 'Home' ? 'char' : event.key === 'End' ? 'user' : actor === 'char' ? 'user' : 'char';
            signature = '';
            render();
            tabButtons[actor].focus();
        });
        controls = el('div', 'ds-actions');
        const sync = button('同步状态', () => invoke(actions.onSync));
        sync.dataset.needsChat = 'true';
        sync.dataset.needsEnabled = 'true';
        const edit = button('编辑状态', () => openEditor('current'));
        edit.dataset.needsState = 'true';
        const settings = button('设置', showSettings);
        const cancel = button('取消等待', () => actions.onCancel());
        cancel.dataset.cancel = 'true';
        controls.append(sync, edit, settings, cancel);
        busyControls.push(sync, edit, settings);
        top.append(tabs, controls);
        status = el('p', 'ds-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        body = el('div', 'ds-groups');
        body.setAttribute('role', 'tabpanel');
        content.append(top, status, body);
        panel.append(content);
        form.before(panel);
    }

    function render() {
        if (!view || !panel) return;
        panel.hidden = !view.settings.enabled;
        panel.setAttribute('aria-busy', String(view.busy));
        badge.textContent = view.busy ? '判定中' : view.statusKind === 'error' ? '需要处理' : view.state ? '已接入剧情' : '待初始化';
        badge.dataset.kind = view.statusKind;
        status.textContent = view.status;
        status.dataset.kind = view.statusKind;
        const feedback = settingsForm?.querySelector('[data-settings-status]');
        if (feedback) { feedback.textContent = view.status; feedback.dataset.kind = view.statusKind; }
        const disabled = view.busy || view.generating;
        for (const control of busyControls) {
            control.disabled = disabled || (control.dataset.needsChat && !view.key) || (control.dataset.needsEnabled && !view.settings.enabled) || (control.dataset.needsState && (!view.state || view.pendingCount > 0));
        }
        for (const input of Object.values(inputs)) input.disabled = disabled;
        controls.querySelector('[data-cancel]').hidden = !view.busy;
        for (const key of ACTORS) {
            tabButtons[key].textContent = `${view.names[key]} · ${key}`;
            tabButtons[key].setAttribute('aria-selected', String(actor === key));
            tabButtons[key].tabIndex = actor === key ? 0 : -1;
        }
        const nextSignature = JSON.stringify([actor, view.state, disabled, view.pendingCount, view.key]);
        if (nextSignature === signature) return;
        signature = nextSignature;
        body.replaceChildren();
        if (!view.state) {
            body.append(el('p', 'ds-empty', !view.key ? '选择一对一聊天后查看双方状态。' : '配置并启用独立 API 后，会自动根据人物与剧情生成初始状态。'));
            return;
        }
        if (view.state.summary) body.append(el('p', 'ds-scene', view.state.summary));
        for (const [group, label] of Object.entries(GROUPS)) {
            const metrics = view.state.actors[actor].filter(item => item.group === group);
            if (!metrics.length) continue;
            const section = el('section', 'ds-group');
            section.append(el('h4', '', label));
            const cards = el('div', 'ds-metrics');
            for (const metric of metrics) {
                const card = el('article', 'ds-metric');
                card.dataset.metric = metric.id;
                const head = el('div', 'ds-metric-head');
                const edit = button(`${metric.value}`, () => openEditor('current', actor, metric.id), 'ds-value');
                edit.setAttribute('aria-label', `修改 ${actor} 的${metric.label}`);
                edit.disabled = disabled || view.pendingCount > 0;
                const delta = metric.delta ? `${metric.delta > 0 ? '+' : ''}${Math.round(metric.delta * 100) / 100}` : '—';
                head.append(el('strong', '', metric.label), edit, el('span', 'ds-delta', delta));
                const progress = el('progress', 'ds-progress');
                progress.max = metric.max - metric.min;
                progress.value = metric.value - metric.min;
                progress.setAttribute('aria-label', `${metric.label} ${metric.value}，范围 ${metric.min} 到 ${metric.max}`);
                card.append(head, progress, el('p', 'ds-description', metric.description));
                const details = el('details', 'ds-reason');
                const openKey = `${actor}/${metric.id}`;
                details.open = reasonOpen.has(openKey);
                details.addEventListener('toggle', () => { if (details.open) reasonOpen.add(openKey); else reasonOpen.delete(openKey); });
                details.append(el('summary', '', '原因与规则'));
                for (const [title, text] of [['本次原因', metric.reason], ['变化规则', metric.rule], ['人物倾向', metric.tendency]]) {
                    if (text) details.append(el('p', '', `${title}：${text}`));
                }
                card.append(details);
                cards.append(card);
            }
            section.append(cards);
            body.append(section);
        }
        if (!view.state.actors[actor].length) body.append(el('p', 'ds-empty', '这一方尚无指标，可在“编辑状态”中添加。'));
    }

    function openEditor(scope, initialActor = actor, metricId) {
        if (!view || view.busy || view.generating) return;
        const source = scope === 'current' ? view.state : scope === 'default' ? view.settings.template : view.settings.characterTemplates[view.characterKey] ?? view.settings.template;
        if (!source || (scope !== 'default' && !view.key)) return;
        const draft = clone(source);
        const ownerKey = view.key;
        let editActor = initialActor, selectedId = metricId ?? draft.actors[editActor][0]?.id;
        dialog = el('dialog', 'ds-dialog');
        editingScope = scope;
        const ownDialog = dialog;
        const title = scope === 'current' ? '编辑当前聊天状态' : scope === 'default' ? '编辑默认模板' : '编辑此角色模板';
        const head = el('header', 'ds-dialog-head');
        head.append(el('h3', '', title), button('关闭', () => ownDialog.close()));
        const form = el('form', 'ds-editor');
        const note = scope === 'current' ? '保存后作为后续判定依据。你的明确输入仍然优先。' : '设置默认初始值与规则；初始化时 API 会结合真实剧情调整。模板只影响之后初始化的聊天。';
        form.append(el('p', 'ds-muted', note));
        const selector = el('div', 'ds-editor-selector');
        const actorSelect = el('select');
        actorSelect.setAttribute('aria-label', '编辑哪一方');
        for (const key of ACTORS) { const option = el('option', '', key); option.value = key; actorSelect.append(option); }
        actorSelect.value = editActor;
        const metricSelect = el('select');
        metricSelect.setAttribute('aria-label', '选择指标');
        const add = button('添加指标', () => {
            if (draft.actors[editActor].length >= 48) { errorBox.textContent = '每方最多 48 项指标'; return; }
            const id = `metric_${Date.now().toString(36)}`;
            draft.actors[editActor].push({ id, label: '新指标', group: 'mind', min: 0, max: 100, value: 50, rule: '', tendency: '', description: '', reason: '', delta: 0 });
            selectedId = id; fill();
        });
        const remove = button('删除此指标', () => {
            draft.actors[editActor] = draft.actors[editActor].filter(m => m.id !== selectedId);
            selectedId = draft.actors[editActor][0]?.id;
            fill();
        });
        selector.append(actorSelect, metricSelect, add, remove);
        form.append(selector);
        const grid = el('div', 'ds-form-grid');
        const fields = {};
        for (const [key, label, type] of [
            ['label', '指标名称', 'text'], ['value', '当前 / 默认值', 'number'],
            ['min', '最小值', 'number'], ['max', '最大值', 'number'],
            ['description', '当前表现', 'textarea'], ['rule', '变化规则', 'textarea'], ['tendency', '人物倾向', 'textarea'],
        ]) {
            const item = field(label, type, key);
            if (type === 'number') item.input.step = 'any';
            if (type === 'textarea') item.wrap.classList.add('ds-span');
            item.input.addEventListener('input', () => {
                const metric = draft.actors[editActor].find(m => m.id === selectedId);
                if (metric) metric[key] = type === 'number' ? (item.input.value === '' ? NaN : Number(item.input.value)) : item.input.value;
                if (key === 'label') {
                    const option = [...metricSelect.options].find(option => option.value === selectedId);
                    if (option) option.textContent = item.input.value || '未命名指标';
                }
            });
            fields[key] = item.input;
            grid.append(item.wrap);
        }
        const groupWrap = el('label', 'ds-field');
        const groupSelect = el('select');
        for (const [key, label] of Object.entries(GROUPS)) { const option = el('option', '', label); option.value = key; groupSelect.append(option); }
        groupSelect.addEventListener('change', () => { const metric = draft.actors[editActor].find(m => m.id === selectedId); if (metric) metric.group = groupSelect.value; });
        groupWrap.append(el('span', '', '分组'), groupSelect);
        grid.prepend(groupWrap);
        form.append(grid);
        const summary = field('场景概况', 'textarea', 'summary');
        summary.input.value = draft.summary;
        summary.input.addEventListener('input', () => { draft.summary = summary.input.value; });
        if (scope === 'current') form.append(summary.wrap);
        const errorBox = el('p', 'ds-status');
        errorBox.dataset.kind = 'error';
        errorBox.setAttribute('role', 'alert');
        const footer = el('footer', 'ds-actions');
        const save = button(scope === 'current' ? '保存当前状态' : '保存模板', null, 'ds-primary');
        save.type = 'submit';
        const cancel = button('取消', () => ownDialog.close());
        footer.append(cancel, save);
        if (scope === 'character') footer.prepend(button('载入默认模板', () => { draft.actors = clone(view.settings.template.actors); selectedId = draft.actors[editActor][0]?.id; fill(); }));
        form.append(errorBox, footer);

        function fill() {
            metricSelect.replaceChildren();
            for (const metric of draft.actors[editActor]) { const option = el('option', '', metric.label); option.value = metric.id; metricSelect.append(option); }
            metricSelect.value = selectedId ?? '';
            const metric = draft.actors[editActor].find(m => m.id === selectedId);
            for (const [key, input] of Object.entries(fields)) { input.value = metric?.[key] ?? ''; input.disabled = !metric; }
            groupSelect.value = metric?.group ?? 'mind';
            groupSelect.disabled = !metric;
            remove.disabled = !metric;
        }
        actorSelect.addEventListener('change', () => { editActor = actorSelect.value; selectedId = draft.actors[editActor][0]?.id; fill(); });
        metricSelect.addEventListener('change', () => { selectedId = metricSelect.value; fill(); });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            errorBox.textContent = '';
            save.disabled = true;
            try { await actions.onSaveEditor(scope, validateState(draft), ownerKey); ownDialog.close(); }
            catch (error) { errorBox.textContent = error.message; }
            finally { save.disabled = false; }
        });
        ownDialog.append(head, form);
        document.body.append(ownDialog);
        ownDialog.addEventListener('close', () => { ownDialog.remove(); if (dialog === ownDialog) dialog = null; }, { once: true });
        fill();
        ownDialog.showModal();
    }

    return {
        mount() { mountSettings(); mountPanel(); render(); },
        update(next) {
            const settingsChanged = !view || next.settings !== view.settings;
            if (lastKey !== next.key) {
                if (dialog && editingScope !== 'default') dialog.close();
                reasonOpen.clear();
                lastKey = next.key;
                signature = '';
            }
            view = next;
            if (settingsChanged || !settingsForm?.dataset.loaded) {
                for (const [key, input] of Object.entries(inputs)) {
                    if (input.type === 'checkbox') input.checked = Boolean(next.settings[key]);
                    else input.value = next.settings[key] ?? '';
                }
                if (settingsForm) settingsForm.dataset.loaded = 'true';
            }
            render();
        },
    };
}
