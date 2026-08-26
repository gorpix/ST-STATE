import { HostAdapter } from './adapter.js';
import { ChatStore } from './store.js';
import { FF5Engine } from './engine.js';
import { DiagnosticLog } from './diagnostics.js';
import { mountSettingsUI, renderDiagnosticEvents, renderReadOnlyDashboard } from './ui.js';
import { stableMessageIdentity } from './identity.js';
import { messageText } from './patch.js';

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
    if (!settings.ff5Engine || typeof settings.ff5Engine !== 'object') settings.ff5Engine = { enabled: true, diagnostics: true };
    if (typeof settings.ff5Engine.enabled !== 'boolean') settings.ff5Engine.enabled = true;
    return settings.ff5Engine;
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
    const attachedIdentity = !message.extra.ff5MessageId;
    if (attachedIdentity) message.extra.ff5MessageId = identity;
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
        getDiagnosticEvents: () => runtimeState.engine?.diagnostics?.list?.() ?? [],
        onRefresh: refreshUI,
    });
    if (!settingsRoot) return;
    runtimeState.ui = {
        settingsRoot,
        dashboard: settingsRoot.querySelector('.ff5-dashboard'),
        diagnosticEvents: settingsRoot.querySelector('.ff5-diagnostic-events'),
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
    runtimeState.engine = new FF5Engine({ adapter, store: runtimeState.store, diagnostics });
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

export async function ff5EngineGenerateInterceptor(chat, _contextSize, _abort, type = 'normal') {
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

