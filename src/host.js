import { KEY } from './model.js';
import { judge, testConnection } from './api.js';

export function createHost(context = () => globalThis.SillyTavern.getContext()) {
    return {
        context,
        capture() {
            const ctx = context();
            const character = ctx.characters?.[ctx.characterId];
            const chatId = ctx.chatId ?? ctx.getCurrentChatId?.();
            if (ctx.groupId || !character || !chatId || !ctx.chatMetadata || !Array.isArray(ctx.chat)) return null;
            const fields = ctx.getCharacterCardFields?.() ?? {};
            return {
                key: JSON.stringify([character.avatar, chatId]),
                characterKey: character.avatar || String(ctx.characterId),
                chatId, avatar: character.avatar,
                chat: ctx.chat, metadata: ctx.chatMetadata, ctx,
                profile: {
                    names: { char: ctx.name2 || character.name || 'char', user: ctx.name1 || 'user' },
                    character: {
                        description: fields.description ?? character.description ?? character.data?.description ?? '',
                        personality: fields.personality ?? character.personality ?? '',
                        scenario: fields.scenario ?? character.scenario ?? '',
                        examples: fields.mesExamples ?? character.mes_example ?? '',
                    },
                    persona: fields.persona ?? ctx.powerUserSettings?.persona_description ?? '',
                },
            };
        },
        inject(text) {
            // Official IN_CHAT, depth 0, SYSTEM; no World Info scan, no chat text edits.
            context().setExtensionPrompt(KEY, text || '', 1, 0, false, 0);
        },
        async save(owner) {
            const current = context();
            if (current.chatMetadata !== owner.metadata || current.chat !== owner.chat) throw new DOMException('聊天已切换', 'AbortError');
            await current.saveMetadata();
            // The native save helper swallows HTTP errors in 1.18. Read back this
            // specific chat before reporting persistence success.
            const response = await fetch('/api/chats/get', {
                method: 'POST', headers: current.getRequestHeaders(), cache: 'no-store',
                body: JSON.stringify({ avatar_url: owner.avatar, file_name: owner.chatId }),
            });
            if (!response.ok) throw new Error('状态保存后无法核验，请检查酒馆连接并重试');
            const data = await response.json();
            if (JSON.stringify(data?.[0]?.chat_metadata?.[KEY]) !== JSON.stringify(owner.metadata[KEY])) {
                throw new Error('状态尚未成功保存到聊天文件，请检查酒馆连接并重试');
            }
        },
        async saveSettings(settings) {
            const ctx = context();
            ctx.extensionSettings[KEY] = settings;
            ctx.saveSettingsDebounced();
        },
        judge(input, settings, signal) {
            return judge(input, settings, { signal, headers: context().getRequestHeaders() });
        },
        test(settings, signal) { return testConnection(settings, { signal, headers: context().getRequestHeaders() }); },
        notify(text) { globalThis.toastr?.error(text, '双向状态', { preventDuplicates: true }); },
    };
}
