import { KEY, sanitizeSettings } from './src/model.js';
import { StateController } from './src/controller.js';
import { createHost } from './src/host.js';
import { createUI } from './src/ui.js';

const host = createHost();
const context = host.context();
let ui;
const controller = new StateController(sanitizeSettings(context.extensionSettings[KEY]), host, view => ui?.update(view));
ui = createUI({
    onSettings: settings => controller.updateSettings(settings),
    onSync: () => controller.sync(),
    onCancel: () => controller.stop(),
    onSaveEditor: (...args) => controller.saveEditor(...args),
    onError: error => controller.report(error),
    onTest: settings => controller.test(settings),
});

globalThis.duetStateBeforeGeneration = async (_chat, _size, abort, type) => controller.before(type, abort);
const events = context.eventTypes;
const on = (name, handler) => { if (events[name]) context.eventSource.on(events[name], handler); };
function mount() { ui.mount(); controller.publish(); }
on('APP_READY', () => { mount(); void controller.switchChat(); });
on('CHAT_CHANGED', () => controller.switchChat());
on('GENERATION_STARTED', (type, _options, dryRun) => controller.start(type, dryRun));
on('GENERATION_STOPPED', () => controller.stop());
on('GENERATION_ENDED', () => controller.ended());
on('CHARACTER_MESSAGE_RENDERED', (_id, type) => controller.after(type));
for (const event of ['MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED']) on(event, () => controller.historyChanged());
on('USER_MESSAGE_RENDERED', () => controller.publish());
mount();
