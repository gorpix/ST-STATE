import { HostAdapter } from './adapter.js';
import { ChatStore } from './store.js';
import { STStateEngine } from './engine.js';
import { DiagnosticLog } from './diagnostics.js';
import { mountSettingsUI, renderDiagnosticEvents, renderReadOnlyDashboard } from './ui.js';
import { stableMessageIdentity } from './identity.js';
import { messageText } from './patch.js';
import { CHAT_CONFIG_KEY, DEFAULT_ENGINE_MODE, ENGINE_MODES, SETTINGS_KEY, ensureGlobalSettings, getChatMode, getGlobalDefaultMode, normalizeEngineMode, setChatMode, setGlobalDefaultMode } from './modes.js';
import { deepClone } from './util.js';

export const runtimeState = {
    adapter: null,
    store: null,
    engine: null,
    settings: null,
    active: true,
    bound: false,
    ui: null,
};

function eventName(adapter, name) {
    return adapter.eventType(name);
}

function resolveEventMessage(adapter, data) {
    const chat = adapter.getChat();
    if (data && typeof data === 'object') {
        if (data.message && typeof data.message === 'object') return data.message;
        if (typeof data.mes === 'string' || typeof data.message === 'string' || typeof data.content === 'string') return data;
        const index = data.messageId ?? data.index ?? data.id;
        if (Number.isInteger(index) && chat[index]) return chat[index];
    }
    if (Number.isInteger(data) && chat[data]) return chat[data];
    return chat.at(-1) ?? null;
}

function messageIndex(adapter, message, data) {
    const chat = adapter.getChat();
    if (Number.isInteger(data?.messageId)) return data.messageId;
    const index = chat.indexOf(message);
    return index >= 0 ? index : -1;
}

function isAssistantMessage(message) {
    if (!message || typeof message !== 'object') return false;
    if (message.is_user === true || message.is_system === true) return false;
    if (message.role && !['assistant', 'character'].includes(String(message.role).toLowerCase())) return false;
    return Boolean(messageText(message));
}

function ensureSettings(adapter) {
    const settings = adapter.getSettings();
    if (!settings) return null;
    return ensureGlobalSettings(settings);
}

function stateHasBaseline(state) {
    return Number(state?.ct ?? state?.meta?.ct ?? 0) > 0
        || String(state?.head ?? state?.meta?.head ?? 'GENESIS') !== 'GENESIS'
        || Object.keys(state?.actors ?? {}).length > 0
        || Boolean(state?.opaque?.legacy?.internalStatesRaw || Object.keys(state?.opaque?.legacy?.sections ?? {}).length);
}

function chatHasLegacyState(adapter) {
    return (adapter?.getChat?.() ?? []).some((message) => /<internal_states\b/i.test(messageText(message)));
}

function refreshUI() {
    if (!runtimeState.ui || !runtimeState.store) return;
    try {
        renderReadOnlyDashboard(runtimeState.ui.dashboard, runtimeState.store.load());
        renderDiagnosticEvents(runtimeState.ui.diagnosticEvents, runtimeState.engine?.diagnostics?.list?.() ?? []);
    } catch { /* diagnostics panel owns host failures */ }
}

async function onMessageReceived(data) {
    if (!runtimeState.active) return;
    const adapter = runtimeState.adapter;
    const engine = runtimeState.engine;
    if (!adapter || !engine) return;
    const message = resolveEventMessage(adapter, data);
    if (!isAssistantMessage(message)) return;
    const index = messageIndex(adapter, message, data);
    const chatId = adapter.getChatId();
    const identity = stableMessageIdentity(message, index, chatId);
    if (!message.extra || typeof message.extra !== 'object' || Array.isArray(message.extra)) message.extra = {};
    const attachedIdentity = !message.extra.stStateMessageId;
    if (attachedIdentity) message.extra.stStateMessageId = identity;
    const result = await engine.processAssistantMessage(message, { index, messageIdentity: identity, expectedChatId: chatId });
    if (attachedIdentity && result.status === 'missing') {
        try { await adapter.saveChat(); } catch { /* message identity is a best-effort branch aid */ }
    }
    refreshUI();
}

function bindEvents() {
    if (runtimeState.bound || !runtimeState.adapter) return;
    const adapter = runtimeState.adapter;
    try {
        adapter.on(eventName(adapter, 'MESSAGE_RECEIVED'), onMessageReceived);
        adapter.on(eventName(adapter, 'CHAT_CHANGED'), () => {
            adapter.clearPrompt();
            refreshUI();
        });
        runtimeState.bound = true;
    } catch (error) {
        runtimeState.engine?.diagnostics.warn('EVENT_HOOKS', `Message/chat event hooks unavailable: ${error.message}`);
    }
}

function mountUI() {
    if (typeof document === 'undefined' || runtimeState.ui || !runtimeState.store) return;
    const settingsRoot = mountSettingsUI({
        host: runtimeState.adapter,
        store: runtimeState.store,
        getMode: () => runtimeState.engine?.getMode?.() ?? DEFAULT_ENGINE_MODE,
        setMode: async (mode) => setRuntimeMode(mode),
        getDefaultMode: () => getGlobalDefaultMode(runtimeState.adapter?.getSettings?.()),
        setDefaultMode: async (mode) => setGlobalRuntimeMode(mode),
        getShadowReport: () => runtimeState.store?.getShadowReport?.(),
        getDiagnosticEvents: () => runtimeState.engine?.diagnostics?.list?.() ?? [],
        onRefresh: refreshUI,
    });
    if (!settingsRoot) return;
    runtimeState.ui = {
        settingsRoot,
        dashboard: settingsRoot.querySelector('.st-dashboard'),
        diagnosticEvents: settingsRoot.querySelector('.st-diagnostic-events'),
    };
    if (!runtimeState.ui.dashboard) {
        runtimeState.ui.dashboard = document.createElement('div');
        settingsRoot.append(runtimeState.ui.dashboard);
        renderReadOnlyDashboard(runtimeState.ui.dashboard, runtimeState.store.load());
    }
}

export function initialize() {
    if (runtimeState.engine) return runtimeState;
    const adapter = new HostAdapter();
    const diagnostics = new DiagnosticLog();
    runtimeState.adapter = adapter;
    runtimeState.store = new ChatStore(adapter);
    runtimeState.engine = new STStateEngine({ adapter, store: runtimeState.store, diagnostics });
    runtimeState.settings = ensureSettings(adapter);
    const capabilities = adapter.diagnostics();
    for (const [key, available] of Object.entries(capabilities)) if (!available && key !== 'stagingFormatterDetected') diagnostics.warn('CAPABILITY', `${key} is unavailable; affected features will remain safely disabled.`);
    bindEvents();
    if (typeof document !== 'undefined') {
        const ready = () => mountUI();
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
        else setTimeout(ready, 0);
    }
    return runtimeState;
}

export async function setRuntimeMode(mode) {
    const adapter = runtimeState.adapter ?? new HostAdapter();
    if (!runtimeState.adapter) runtimeState.adapter = adapter;
    const metadata = adapter.getMetadata?.();
    const normalized = normalizeEngineMode(mode);
    const store = runtimeState.store ?? new ChatStore(adapter);
    if (normalized === 'SHADOW' && chatHasLegacyState(adapter) && !stateHasBaseline(store.load({ initialize: false }))) {
        throw new Error('Import the latest chat <internal_states> baseline before enabling Shadow mode.');
    }
    const hadPrevious = Object.prototype.hasOwnProperty.call(metadata ?? {}, CHAT_CONFIG_KEY);
    const previous = hadPrevious ? deepClone(metadata[CHAT_CONFIG_KEY]) : undefined;
    const selected = setChatMode(metadata, mode, { now: Date.now() });
    try {
        await adapter.saveMetadata?.();
    } catch (error) {
        if (hadPrevious) metadata[CHAT_CONFIG_KEY] = previous;
        else delete metadata[CHAT_CONFIG_KEY];
        runtimeState.engine?.diagnostics?.warn('MODE_SAVE', `Could not persist chat mode: ${error.message}`);
        throw error;
    }
    refreshUI();
    return selected;
}

export async function setGlobalRuntimeMode(mode) {
    const adapter = runtimeState.adapter ?? new HostAdapter();
    if (!runtimeState.adapter) runtimeState.adapter = adapter;
    const settings = adapter.getSettings?.();
    const normalized = normalizeEngineMode(mode);
    const store = runtimeState.store ?? new ChatStore(adapter);
    if (normalized === 'SHADOW' && chatHasLegacyState(adapter) && !stateHasBaseline(store.load({ initialize: false }))) {
        throw new Error('Import the latest chat <internal_states> baseline before making Shadow the default.');
    }
    const hadPrevious = Object.prototype.hasOwnProperty.call(settings ?? {}, SETTINGS_KEY);
    const previous = hadPrevious ? deepClone(settings[SETTINGS_KEY]) : undefined;
    const selected = setGlobalDefaultMode(settings, normalized);
    try {
        await adapter.saveSettingsDebounced?.();
    } catch (error) {
        if (hadPrevious) settings[SETTINGS_KEY] = previous;
        else delete settings[SETTINGS_KEY];
        runtimeState.engine?.diagnostics?.warn('SETTINGS_SAVE', `Could not persist global default mode: ${error.message}`);
        throw error;
    }
    refreshUI();
    return selected;
}

export async function stStateGenerateInterceptor(chat, _contextSize, _abort, type = 'normal') {
    if (!runtimeState.engine) initialize();
    if (!runtimeState.engine || !runtimeState.active) return;
    runtimeState.adapter?.noteGenerationType?.(type);
    const chatArray = Array.isArray(chat) ? chat : [];
    const latestUser = [...chatArray].reverse().find((message) => message?.is_user === true || message?.role === 'user');
    return runtimeState.engine.injectPrompt(type, { userText: latestUser ? messageText(latestUser) : runtimeState.engine.latestUserText() });
}

export function getRuntime() {
    return runtimeState;
}

export async function onActivate() {
    initialize();
}

export async function onInstall() {
    initialize();
    if (runtimeState.adapter?.saveSettingsDebounced) {
        try { runtimeState.adapter.saveSettingsDebounced(); } catch { /* diagnostics handles missing persistence */ }
    }
}

export async function onUpdate() {
    initialize();
}

export function onEnable() {
    runtimeState.active = true;
    if (!runtimeState.engine) initialize();
}
export function onDisable() {
    runtimeState.active = false;
    runtimeState.adapter?.clearPrompt();
}

