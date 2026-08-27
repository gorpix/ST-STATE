import { EXTENSION_KEY } from './schema.js';

export const PROMPT_KEY = 'stState.hotState';

function defaultContextResolver() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

export class HostAdapter {
    constructor(contextResolver = defaultContextResolver) {
        this.contextResolver = contextResolver;
        this.lastGenerationType = null;
    }

    context() {
        try { return this.contextResolver?.() ?? null; } catch (error) { this.lastError = error; return null; }
    }

    getMetadata() {
        return this.context()?.chatMetadata ?? null;
    }

    getChatId() {
        const context = this.context();
        try {
            return context?.getCurrentChatId?.() ?? context?.chatId ?? context?.groupId ?? context?.characterId ?? '';
        } catch { return ''; }
    }

    getChat() {
        const chat = this.context()?.chat;
        return Array.isArray(chat) ? chat : [];
    }

    getUserName() {
        const context = this.context();
        return String(context?.name1 ?? '').trim();
    }

    getSettings() {
        const context = this.context();
        if (!context || typeof context.extensionSettings !== 'object' || context.extensionSettings === null) return null;
        return context.extensionSettings;
    }

    async saveMetadata() {
        const context = this.context();
        if (typeof context?.saveMetadata === 'function') return context.saveMetadata();
        if (typeof context?.saveMetadataDebounced === 'function') return context.saveMetadataDebounced();
        throw new Error('SillyTavern saveMetadata API is unavailable');
    }

    saveSettingsDebounced() {
        const context = this.context();
        if (typeof context?.saveSettingsDebounced !== 'function') throw new Error('SillyTavern saveSettingsDebounced API is unavailable');
        return context.saveSettingsDebounced();
    }

    async saveChat() {
        const context = this.context();
        if (typeof context?.saveChat === 'function') return context.saveChat();
        // Chat objects are already mutable in release ST. There is no safe
        // generic fallback that should fabricate an API call here.
        return undefined;
    }

    setPrompt(value, { key = PROMPT_KEY, position = 1, depth = 0, scan = false, role = 0 } = {}) {
        const context = this.context();
        if (typeof context?.setExtensionPrompt !== 'function') throw new Error('SillyTavern setExtensionPrompt API is unavailable');
        return context.setExtensionPrompt(key, String(value ?? ''), position, depth, scan, role);
    }

    clearPrompt({ key = PROMPT_KEY } = {}) {
        try { return this.setPrompt('', { key }); } catch { return undefined; }
    }

    noteGenerationType(type) {
        const normalized = String(type ?? '').trim();
        if (normalized) this.lastGenerationType = normalized;
        return this.lastGenerationType;
    }

    on(eventType, handler) {
        const source = this.context()?.eventSource;
        if (typeof source?.on !== 'function') throw new Error('SillyTavern eventSource.on API is unavailable');
        return source.on(eventType, handler);
    }

    eventType(name) {
        const context = this.context();
        return context?.eventTypes?.[name] ?? context?.event_types?.[name] ?? name;
    }

    libs() {
        return globalThis.SillyTavern?.libs ?? this.context()?.libs ?? {};
    }

    notify(level, message) {
        const toast = globalThis.toastr?.[level];
        if (typeof toast === 'function') toast(String(message));
        else if (level === 'error') console.error(`[ST-STATE] ${message}`);
        else console.warn(`[ST-STATE] ${message}`);
    }

    diagnostics() {
        const context = this.context();
        const eventTypes = context?.eventTypes ?? context?.event_types ?? {};
        const metadata = context?.chatMetadata;
        const settings = context?.extensionSettings;
        return {
            storage: !!metadata && typeof metadata === 'object',
            settingsStorage: !!settings && typeof settings === 'object',
            persistence: typeof context?.saveMetadata === 'function' || typeof context?.saveMetadataDebounced === 'function',
            settingsPersistence: typeof context?.saveSettingsDebounced === 'function',
            promptInjection: typeof context?.setExtensionPrompt === 'function',
            messageEventHooks: typeof context?.eventSource?.on === 'function' && !!(eventTypes.MESSAGE_RECEIVED || eventTypes.message_received),
            chatChangeHooks: typeof context?.eventSource?.on === 'function' && !!(eventTypes.CHAT_CHANGED || eventTypes.chat_changed),
            // Release SillyTavern supplies the type as the fourth argument to
            // the manifest generation interceptor. At initialization no turn
            // has run yet, so lastGenerationType is expected to be empty.
            generationType: typeof globalThis.stStateGenerateInterceptor === 'function'
                || !!this.lastGenerationType
                || typeof context?.generationType === 'string'
                || typeof context?.generation_type === 'string',
            saveChat: typeof context?.saveChat === 'function',
            releaseContext: !!context,
            stagingFormatterDetected: !!context?.messageFormatter,
        };
    }
}

export function createDefaultAdapter() {
    return new HostAdapter();
}

