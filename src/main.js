import { HostAdapter } from './adapter.js';
import { ChatStore } from './store.js';
import { inspectShadowBaseline, preserveCanonicalBookkeeping, recordControlMetadata, STStateEngine } from './engine.js';
import { DiagnosticLog } from './diagnostics.js';
import { mountSettingsUI, renderDiagnosticEvents, renderReadOnlyDashboard, renderShadowParity } from './ui.js';
import { stableMessageIdentity } from './identity.js';
import { extractHiddenPatch, messageText, removeControlPayload, stripMessageControlPayload } from './patch.js';
import { CHAT_CONFIG_KEY, DEFAULT_ENGINE_MODE, ENGINE_MODES, SETTINGS_KEY, ensureGlobalSettings, getChatMode, getGlobalDefaultMode, normalizeEngineMode, setChatMode, setGlobalDefaultMode } from './modes.js';
import { deepClone, stableHash } from './util.js';
import { importLegacyState, removeInternalStatesPayload, stripMessageInternalStatesPayload } from './legacy.js';
import { BRANCH_SIDECAR_KEY, checkpointAssistantSlot, createBranchLedger, invalidateAssistantDelete, invalidateAssistantEdit, latestAssistantCheckpoint, prepareSwipeEvaluation, recordAssistantSwipeResult, registerAssistantSwipe, restoreAssistantCheckpoint, stableSwipeIdentity } from './branch.js';
import { EXTENSION_KEY } from './schema.js';
import { SHADOW_SIDECAR_KEY } from './modes.js';
import { extractGfxProtocol, GFX_MEDIA_KINDS, removeGfxControl } from './gfx.js';
import { createGfxOverlay } from './gfx-overlay.js?v=0.4.3';
import { applyDiff } from './reducer.js';

export const runtimeState = {
    adapter: null,
    store: null,
    engine: null,
    settings: null,
    active: true,
    bound: false,
    ui: null,
    gfxOverlay: null,
    quickDashboard: null,
    chatTopology: [],
};

export const QUICK_DASHBOARD_LAUNCHER_ID = 'st-state-dashboard-launcher';
export const QUICK_DASHBOARD_PANEL_ID = 'st-state-quick-dashboard';

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

function eventMessageIndex(data) {
    if (Number.isInteger(data)) return data;
    for (const value of [data?.messageId, data?.index, data?.id]) if (Number.isInteger(value)) return value;
    return -1;
}

function branchSlotId(adapter, index) {
    return `slot:${String(adapter?.getChatId?.() ?? '')}:${Number.isInteger(index) ? index : -1}`;
}

function selectedSwipeIndex(message) {
    return Number.isInteger(message?.swipe_id) && message.swipe_id >= 0 ? message.swipe_id : 0;
}

function selectedSwipeTarget(message, swipeIndex = selectedSwipeIndex(message)) {
    const swipes = Array.isArray(message?.swipes) ? message.swipes : null;
    if (swipes && swipeIndex >= swipes.length) return { text: '', pending: true };
    if (swipes && typeof swipes[swipeIndex] === 'string') return { text: swipes[swipeIndex], pending: false };
    return { text: messageText(message), pending: false };
}

function branchOptions(adapter, message, index, swipeIndexOverride = undefined) {
    const slotId = branchSlotId(adapter, index);
    const swipeIndex = Number.isInteger(swipeIndexOverride) ? swipeIndexOverride : selectedSwipeIndex(message);
    const target = selectedSwipeTarget(message, swipeIndex);
    const contentHash = stableHash(removeInternalStatesPayload(removeControlPayload(removeGfxControl(target.text))));
    const providerSwipeId = message?.swipe_info?.[swipeIndex]?.send_date;
    return {
        slotId,
        messageId: slotId,
        index,
        swipeIndex,
        swipeIdentity: stableSwipeIdentity({ slotId, swipeId: providerSwipeId, contentHash, swipeIndex, index }),
        contentHash,
        pendingSwipe: target.pending,
        selectedText: target.text,
        at: Date.now(),
    };
}

function isTransactionalMode(mode) {
    return mode === 'SHADOW' || mode === 'NATIVE';
}

const GFX_CACHE_KEY = 'stStateGfx';
const MAX_GFX_CACHE_ENTRIES = 8;

function gfxOptions(adapter = runtimeState.adapter) {
    const settings = ensureSettings(adapter) ?? {};
    const duration = Number(settings.gfxDurationMs);
    return {
        enabled: settings.gfxEnabled !== false,
        duration: Number.isFinite(duration) ? Math.max(2000, Math.min(20000, Math.trunc(duration))) : 7000,
        maxVisible: 1,
        reducedMotion: Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches),
        phoneEventProvider: () => latestCachedPhoneEvent(adapter),
    };
}

function latestCachedPhoneEvent(adapter = runtimeState.adapter) {
    const chat = adapter?.getChat?.() ?? [];
    const chatId = String(adapter?.getChatId?.() ?? '');
    for (let index = chat.length - 1; index >= 0; index -= 1) {
        const message = chat[index];
        if (!isAssistantSlot(message)) continue;
        const options = branchOptions(adapter, message, index);
        const cached = gfxCache(message)?.[options.swipeIdentity];
        const target = selectedSwipeTarget(message, options.swipeIndex);
        const parsed = target.pending ? null : extractGfxProtocol(target.text).events?.[0];
        const event = cached?.kind === 'phone' ? cached : (parsed?.kind === 'phone' ? parsed : null);
        if (!event) continue;
        return {
            ...deepClone(event),
            branchId: `${chatId}:${options.slotId}:${options.swipeIdentity}`,
        };
    }
    return null;
}

function ensureGfxOverlay() {
    if (runtimeState.gfxOverlay) {
        runtimeState.gfxOverlay.configure?.({ ...gfxOptions(), dashboardToggle: () => toggleQuickDashboard() });
        return runtimeState.gfxOverlay;
    }
    if (typeof document === 'undefined') return null;
    runtimeState.gfxOverlay = createGfxOverlay({ ...gfxOptions(), dashboardToggle: () => toggleQuickDashboard() });
    return runtimeState.gfxOverlay;
}

function setQuickDashboardOpen(quick, open) {
    if (!quick) return false;
    quick.panel.hidden = !open;
    quick.launcher.setAttribute?.('aria-expanded', open ? 'true' : 'false');
    quick.launcher.setAttribute?.('aria-label', open ? 'Close ST-STATE dashboard' : 'Open ST-STATE dashboard');
    quick.launcher.setAttribute?.('title', open ? 'Close ST-STATE dashboard' : 'Open ST-STATE dashboard');
    if (open && runtimeState.store) renderReadOnlyDashboard(quick.content, runtimeState.store.load());
    return open;
}

function ensureQuickDashboard() {
    if (typeof document === 'undefined' || !runtimeState.store) return null;
    if (runtimeState.quickDashboard && runtimeState.quickDashboard.launcher?.isConnected !== false) return runtimeState.quickDashboard;
    const parent = document.body ?? document.documentElement;
    if (!parent?.append) return null;

    let launcher = document.querySelector?.(`#${QUICK_DASHBOARD_LAUNCHER_ID}`);
    if (!launcher) {
        launcher = document.createElement('button');
        launcher.id = QUICK_DASHBOARD_LAUNCHER_ID;
        parent.append(launcher);
    }
    launcher.className = 'st-state-dashboard-launcher';
    launcher.type = 'button';
    launcher.textContent = '📊';
    launcher.setAttribute?.('aria-controls', QUICK_DASHBOARD_PANEL_ID);
    launcher.setAttribute?.('aria-expanded', 'false');
    launcher.setAttribute?.('aria-label', 'Open ST-STATE dashboard');
    launcher.setAttribute?.('title', 'Open ST-STATE dashboard');
    launcher.hidden = !runtimeState.active;

    let panel = document.querySelector?.(`#${QUICK_DASHBOARD_PANEL_ID}`);
    if (!panel) {
        panel = document.createElement('section');
        panel.id = QUICK_DASHBOARD_PANEL_ID;
        panel.className = 'st-state-quick-dashboard-panel';
        panel.setAttribute?.('role', 'dialog');
        panel.setAttribute?.('aria-label', 'ST-STATE dashboard');
        panel.hidden = true;
        const bar = document.createElement('div');
        bar.className = 'st-state-quick-dashboard-bar';
        const title = document.createElement('strong');
        title.textContent = 'State dashboard';
        const close = document.createElement('button');
        close.className = 'st-state-quick-dashboard-close';
        close.type = 'button';
        close.textContent = '×';
        close.setAttribute?.('aria-label', 'Close ST-STATE dashboard');
        const content = document.createElement('div');
        content.className = 'st-state-quick-dashboard-content';
        bar.append(title, close);
        panel.append(bar, content);
        parent.append(panel);
    }
    const content = panel.querySelector?.('.st-state-quick-dashboard-content');
    const close = panel.querySelector?.('.st-state-quick-dashboard-close');
    if (!content) return null;
    const quick = { launcher, panel, content };
    launcher.onclick = () => setQuickDashboardOpen(quick, panel.hidden);
    if (close) close.onclick = () => setQuickDashboardOpen(quick, false);
    runtimeState.quickDashboard = quick;
    return quick;
}

export function toggleQuickDashboard(force = undefined) {
    const quick = ensureQuickDashboard();
    if (!quick) return false;
    const open = typeof force === 'boolean' ? force : quick.panel.hidden;
    return setQuickDashboardOpen(quick, open);
}

function gfxCache(message, { initialize = false } = {}) {
    if (!message || typeof message !== 'object') return null;
    if (!message.extra || typeof message.extra !== 'object' || Array.isArray(message.extra)) {
        if (!initialize) return null;
        message.extra = {};
    }
    if (!message.extra[GFX_CACHE_KEY] || typeof message.extra[GFX_CACHE_KEY] !== 'object' || Array.isArray(message.extra[GFX_CACHE_KEY])) {
        if (!initialize) return null;
        message.extra[GFX_CACHE_KEY] = {};
    }
    return message.extra[GFX_CACHE_KEY];
}

function cacheGfxEvent(message, identity, event) {
    const cache = gfxCache(message, { initialize: true });
    cache[identity] = deepClone(event);
    const keys = Object.keys(cache);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_GFX_CACHE_ENTRIES))) delete cache[key];
}

function clearGfxCache(message, identity = undefined) {
    const cache = gfxCache(message);
    if (!cache) return false;
    if (identity !== undefined) {
        if (!Object.prototype.hasOwnProperty.call(cache, identity)) return false;
        delete cache[identity];
        if (!Object.keys(cache).length) delete message.extra[GFX_CACHE_KEY];
        return true;
    }
    delete message.extra[GFX_CACHE_KEY];
    return true;
}

function setMessageText(message, value) {
    if (Object.prototype.hasOwnProperty.call(message, 'mes')) message.mes = value;
    else if (Object.prototype.hasOwnProperty.call(message, 'message')) message.message = value;
    else if (Object.prototype.hasOwnProperty.call(message, 'content')) message.content = value;
}

function stripSelectedGfxControl(message, swipeIndex) {
    setMessageText(message, removeGfxControl(messageText(message)));
    if (Array.isArray(message?.swipes) && typeof message.swipes[swipeIndex] === 'string') {
        message.swipes[swipeIndex] = removeGfxControl(message.swipes[swipeIndex]);
    }
}

function sameChat(adapter, expectedChatId) {
    return String(adapter?.getChatId?.() ?? '') === String(expectedChatId ?? '');
}

async function guardedSaveChat(adapter, expectedChatId) {
    if (!sameChat(adapter, expectedChatId)) return false;
    if (typeof adapter?.saveChat !== 'function') return false;
    const capabilities = adapter.capabilities?.();
    if (capabilities && capabilities.saveChat === false) return false;
    await adapter.saveChat({ expectedChatId });
    return sameChat(adapter, expectedChatId);
}

function acceptsLocalGfx(result) {
    if (result?.persisted !== true) return false;
    if (result?.mode === 'NATIVE') return result?.status === 'native_committed';
    return result?.mode === 'SHADOW' && ['shadow_match', 'shadow_not_comparable', 'shadow_diverged'].includes(result?.status);
}

/** Parse, cache, strip, and locally render the selected message's visual artifact. */
export async function renderLocalGfx(message, index, { expectedChatId = undefined } = {}) {
    const adapter = runtimeState.adapter;
    if (!runtimeState.active || !adapter || !isTransactionalMode(runtimeState.engine?.getMode?.()) || !isAssistantSlot(message)) return { status: 'ignored' };
    const targetChatId = String(expectedChatId ?? adapter.getChatId?.() ?? '');
    if (!sameChat(adapter, targetChatId)) return { status: 'chat_changed' };
    const options = branchOptions(adapter, message, index);
    const branchId = `${targetChatId}:${options.slotId}:${options.swipeIdentity}`;
    const target = selectedSwipeTarget(message, options.swipeIndex);
    const extracted = extractGfxProtocol(target.pending ? '' : target.text);
    let event = extracted.events?.[0] ?? null;
    const cache = gfxCache(message);
    // Cached events are only a replay aid after a valid control was stripped.
    // A new, malformed, or dangling control is authoritative and must never
    // resurrect the prior artifact for an otherwise identical swipe.
    if (!event && !extracted.controlBearing && cache?.[options.swipeIdentity]) event = deepClone(cache[options.swipeIdentity]);
    if (extracted.controlBearing) {
        if (!sameChat(adapter, targetChatId)) return { status: 'chat_changed' };
        const rollbackText = messageText(message);
        const rollbackSwipes = Array.isArray(message.swipes) ? message.swipes.slice() : null;
        const hadExtra = Object.prototype.hasOwnProperty.call(message, 'extra');
        const rollbackExtra = hadExtra && message.extra && typeof message.extra === 'object'
            ? deepClone(message.extra) : null;
        clearGfxCache(message, options.swipeIdentity);
        stripSelectedGfxControl(message, options.swipeIndex);
        if (event) cacheGfxEvent(message, options.swipeIdentity, event);
        // ST-STATE's engine persists its own cleanup before this presentation
        // hook runs. Persist the additional ST_GFX removal and cache now, or a
        // chat reload can resurrect the model control and render it again.
        let saved = false;
        try { saved = await guardedSaveChat(adapter, targetChatId); } catch (error) {
            runtimeState.engine?.diagnostics?.warn?.('GFX_SAVE', `Local GFX cleanup could not be persisted: ${error.message}`);
        }
        if (!saved) {
            setMessageText(message, rollbackText);
            if (rollbackSwipes) message.swipes = rollbackSwipes;
            if (hadExtra) message.extra = rollbackExtra;
            else if (message.extra && typeof message.extra === 'object') delete message.extra[GFX_CACHE_KEY];
            runtimeState.gfxOverlay?.clear?.();
            return { status: 'persistence_error', event: null, branchId };
        }
    }
    if (extracted.found && !extracted.ok) {
        runtimeState.engine?.diagnostics?.warn?.('GFX_MALFORMED', `Local GFX hint was rejected: ${(extracted.errors ?? []).join('; ')}`);
    }
    if (!sameChat(adapter, targetChatId)) {
        runtimeState.gfxOverlay?.clear?.();
        return { status: 'chat_changed' };
    }
    const overlay = ensureGfxOverlay();
    if (!overlay) return { status: event ? 'unavailable' : 'empty', event, branchId };
    if (!event) {
        overlay.replaceBranch?.(branchId, []);
        return { status: extracted.found ? 'rejected' : 'empty', event: null, branchId };
    }
    const rendered = {
        ...deepClone(event),
        id: `${options.swipeIdentity}:${event.id}`,
        branchId,
        visibility: 'public',
    };
    overlay.replaceBranch?.(branchId, [rendered]);
    return { status: 'rendered', event: rendered, branchId };
}

function topologyEntry(message) {
    const role = message?.is_user === true ? 'user' : (message?.is_system === true ? 'system' : 'assistant');
    const target = selectedSwipeTarget(message);
    return stableHash({ role, sendDate: message?.send_date ?? '', pending: target.pending, text: removeControlPayload(target.text) });
}

function snapshotChatTopology(adapter = runtimeState.adapter) {
    return (adapter?.getChat?.() ?? []).map(topologyEntry);
}

function detectDeletedIndex(previous, current, fallback) {
    if (!Array.isArray(previous) || previous.length !== current.length + 1) return fallback;
    let index = 0;
    while (index < current.length && previous[index] === current[index]) index += 1;
    return index;
}

function isAssistantSlot(message) {
    if (!message || typeof message !== 'object') return false;
    if (message.is_user === true || message.is_system === true) return false;
    if (message.role && !['assistant', 'character'].includes(String(message.role).toLowerCase())) return false;
    return true;
}

function isAssistantMessage(message) {
    if (!isAssistantSlot(message)) return false;
    return Boolean(messageText(message));
}

function ensureSettings(adapter) {
    const settings = adapter.getSettings();
    if (!settings) return null;
    return ensureGlobalSettings(settings);
}

function requireCurrentShadowBaseline(adapter, loadState, action) {
    let baseline = inspectShadowBaseline(adapter, undefined);
    if (baseline.ready) return baseline;
    baseline = inspectShadowBaseline(adapter, loadState());
    if (baseline.ready) return baseline;
    const mismatch = baseline.status === 'stale' && baseline.canonical.ct === baseline.legacy.ct
        ? `Canonical state differs from the selected branch at ct ${baseline.canonical.ct}`
        : `Canonical ct ${baseline.canonical?.ct} does not match selected branch ct ${baseline.legacy?.ct}`;
    const message = baseline.status === 'stale'
        ? `${mismatch}. Rebaseline selected branch before ${action}.`
        : `Import the latest chat <internal_states> usable baseline before ${action}.`;
    runtimeState.engine?.diagnostics?.warn(baseline.status === 'stale' ? 'BASELINE_STALE' : 'BASELINE_REQUIRED', message, baseline);
    adapter.notify?.('warning', message);
    throw new Error(message);
}

function refreshUI() {
    if (!runtimeState.store) return;
    try {
        if (runtimeState.ui) {
            const mode = runtimeState.ui.settingsRoot?.querySelector?.('[aria-label="ST-STATE chat mode"]');
            const defaultMode = runtimeState.ui.settingsRoot?.querySelector?.('[aria-label="ST-STATE global default mode"]');
            if (mode) mode.value = runtimeState.engine?.getMode?.() ?? DEFAULT_ENGINE_MODE;
            if (defaultMode) defaultMode.value = getGlobalDefaultMode(runtimeState.adapter?.getSettings?.());
            renderReadOnlyDashboard(runtimeState.ui.dashboard, runtimeState.store.load());
            renderDiagnosticEvents(runtimeState.ui.diagnosticEvents, runtimeState.engine?.diagnostics?.list?.() ?? []);
            renderShadowParity(runtimeState.ui.parity, runtimeState.store.getShadowReport?.());
        }
        const quick = runtimeState.quickDashboard;
        if (quick && !quick.panel.hidden) renderReadOnlyDashboard(quick.content, runtimeState.store.load());
    } catch { /* diagnostics panel owns host failures */ }
}

export async function handleMessageReceived(data) {
    if (!runtimeState.active) return;
    const adapter = runtimeState.adapter;
    const engine = runtimeState.engine;
    if (!adapter || !engine) return;
    const message = resolveEventMessage(adapter, data);
    if (!isAssistantMessage(message)) return;
    const index = messageIndex(adapter, message, data);
    const chatId = adapter.getChatId();
    const activeMode = engine.getMode?.();
    const branchActive = isTransactionalMode(activeMode);
    const options = branchActive ? branchOptions(adapter, message, index) : null;
    const identity = options?.swipeIdentity || stableMessageIdentity(message, index, chatId);
    const before = runtimeState.store?.load?.();
    if (branchActive && before && runtimeState.store?.loadBranchLedger && runtimeState.store?.saveBranchLedger) {
        try {
            const checkpoint = checkpointAssistantSlot(runtimeState.store.loadBranchLedger(), { ...options, state: before });
            await runtimeState.store.saveBranchLedger(checkpoint.ledger, { expectedChatId: chatId });
        } catch (error) {
            engine.diagnostics?.warn?.('BRANCH_CHECKPOINT', `Could not save the pre-response branch checkpoint: ${error.message}`);
        }
    }
    if (branchActive && (!message.extra || typeof message.extra !== 'object' || Array.isArray(message.extra))) message.extra = {};
    const attachedIdentity = branchActive && !message.extra.stStateMessageId;
    if (attachedIdentity) message.extra.stStateMessageId = identity;
    const result = await engine.processAssistantMessage(message, { index, messageIdentity: identity, expectedChatId: chatId });
    if (branchActive && runtimeState.store?.loadBranchLedger && runtimeState.store?.saveBranchLedger) {
        try {
            let selected = prepareSwipeEvaluation(runtimeState.store.loadBranchLedger(), options);
            if (selected.ok && result.mode === 'NATIVE' && result.status === 'native_committed') {
                selected = recordAssistantSwipeResult(selected.ledger, {
                    ...options,
                    mode: 'NATIVE',
                    state: result.state,
                    diff: result.diff?.forward ?? [],
                });
            }
            if (selected.ok) await runtimeState.store.saveBranchLedger(selected.ledger, { expectedChatId: chatId });
        } catch (error) {
            engine.diagnostics?.warn?.('BRANCH_SELECT', `Could not record the selected swipe: ${error.message}`);
        }
    }
    if (attachedIdentity && result.status === 'missing' && sameChat(adapter, chatId)) {
        try { await guardedSaveChat(adapter, chatId); } catch { /* message identity is a best-effort branch aid */ }
    }
    runtimeState.chatTopology = snapshotChatTopology(adapter);
    refreshUI();
    if (acceptsLocalGfx(result) && sameChat(adapter, chatId)) await renderLocalGfx(message, index, { expectedChatId: chatId });
    else runtimeState.gfxOverlay?.clear?.();
    return result;
}

function branchReport(kind, state, options = {}) {
    return {
        version: 1,
        status: kind,
        mode: 'SHADOW',
        at: Date.now(),
        messageId: options.swipeIdentity ?? options.messageId ?? '',
        previous: options.previous ? { ct: options.previous.ct, head: options.previous.head } : undefined,
        legacy: options.legacy ?? { status: kind },
        patch: { status: 'not_evaluated', base: null, tx: null, opsCount: 0, errors: [] },
        canonical: { source: options.source ?? 'branch', persisted: true, ct: state.ct, head: state.head },
    };
}

function recoverOldCheckpoint(store) {
    const backup = store?.getShadowReport?.()?.recoveryBackup;
    if (!backup) return null;
    try { return store.parseBackup(backup).state; } catch { return null; }
}

function inferBranchCheckpoint(adapter, index, baseState) {
    const prefix = (adapter?.getChat?.() ?? []).slice(0, index).map((message) => messageText(message)).join('\n');
    if (!/<internal_states\b/i.test(prefix)) return null;
    const imported = importLegacyState(prefix, {
        now: Date.now(),
        baseState,
        preserveMissingFromBase: true,
        mergeSparseFromBase: true,
        requireTurn: true,
        userName: adapter?.getUserName?.(),
    });
    return imported.ok ? preserveCanonicalBookkeeping(imported.state, baseState) : null;
}

async function cleanBranchControl(message, status, adapter, expectedChatId) {
    if (!sameChat(adapter, expectedChatId)) return false;
    const extracted = extractHiddenPatch(messageText(message));
    if (!extracted.controlBearing) return true;
    const mode = runtimeState.engine?.getMode?.() ?? 'SHADOW';
    recordControlMetadata(message, extracted, { status, mode }, Date.now());
    stripMessageControlPayload(message);
    if (mode === 'NATIVE') stripMessageInternalStatesPayload(message);
    try { return await guardedSaveChat(adapter, expectedChatId); }
    catch { return false; /* metadata authority is already safe */ }
}

async function persistBranchCommit(state, ledger, report, { adapter, store, engine, expectedChatId = undefined }) {
    const targetChatId = String(expectedChatId ?? adapter.getChatId?.() ?? '');
    try {
        await store.saveBranchCommit(state, ledger, report, { expectedChatId: targetChatId });
        return true;
    } catch (error) {
        engine.diagnostics?.error?.('BRANCH_PERSISTENCE', `Branch state was not persisted: ${error.message}`);
        adapter.clearPrompt?.();
        runtimeState.gfxOverlay?.clear?.();
        let recoveryPersisted = false;
        if (String(adapter.getChatId?.() ?? '') === targetChatId) {
            try {
                setChatMode(adapter.getMetadata?.(), 'RECOVERY', { now: Date.now() });
                await adapter.saveMetadata?.();
                recoveryPersisted = String(adapter.getChatId?.() ?? '') === targetChatId;
            } catch (latchError) {
                engine.diagnostics?.error?.('RECOVERY_LATCH', `Recovery mode could not be persisted: ${latchError.message}`);
            }
        }
        adapter.notify?.('error', recoveryPersisted
            ? 'ST-STATE could not persist the branch. Recovery mode was enabled for safety.'
            : 'ST-STATE could not persist the branch or recovery latch. Select RECOVERY before continuing.');
        return false;
    }
}

/** Restore the common pre-response checkpoint, then adopt the selected usable swipe state. */
export async function handleMessageSwiped(data) {
    const adapter = runtimeState.adapter;
    const store = runtimeState.store;
    const engine = runtimeState.engine;
    const activeMode = engine?.getMode?.();
    if (!runtimeState.active || !adapter || !store || !engine || !isTransactionalMode(activeMode)) return { status: 'ignored' };
    const chatId = String(adapter.getChatId?.() ?? '');
    runtimeState.gfxOverlay?.clear?.();
    const index = eventMessageIndex(data);
    const message = adapter.getChat?.()?.[index];
    if (!isAssistantSlot(message)) return { status: 'ignored' };
    const options = branchOptions(adapter, message, index);
    let ledger = store.loadBranchLedger?.({ initialize: false });
    let selected = prepareSwipeEvaluation(ledger, options);
    if (!selected.ok) {
        const fallback = inferBranchCheckpoint(adapter, index, store.load()) ?? recoverOldCheckpoint(store);
        if (!fallback) {
            engine.diagnostics?.warn?.('BRANCH_BASELINE', 'No pre-response checkpoint exists for this swipe. Use Rebaseline selected branch.');
            adapter.notify?.('warning', 'ST-STATE needs Rebaseline selected branch for this older swipe.');
            return { status: 'missing_checkpoint' };
        }
        const checkpoint = checkpointAssistantSlot(ledger, { ...options, state: fallback });
        ledger = checkpoint.ledger;
        selected = prepareSwipeEvaluation(ledger, options);
        engine.diagnostics?.info?.('BRANCH_AUTO_REBASELINE', `Rebuilt the selected branch checkpoint at ct ${fallback.ct}.`);
    }
    const checkpointState = selected.restoreState;
    const imported = activeMode === 'SHADOW' && !options.pendingSwipe ? importLegacyState(options.selectedText, {
        now: Date.now(), baseState: checkpointState, preserveMissingFromBase: true, mergeSparseFromBase: true,
        requireTurn: true, userName: adapter.getUserName?.(),
    }) : { ok: false, diagnostics: [options.pendingSwipe ? 'Pending overswipe' : 'Native swipe uses its stored branch diff'] };
    let canonical = checkpointState;
    let status = 'branch_checkpoint';
    let source = 'branch-checkpoint';
    if (activeMode === 'NATIVE' && !options.pendingSwipe && selected.swipe?.commitMode === 'NATIVE' && Array.isArray(selected.swipe.diff)) {
        const replayed = applyDiff(checkpointState, selected.swipe.diff);
        if (replayed.ct === selected.swipe.commitCt && replayed.head === selected.swipe.commitHead) {
            canonical = replayed;
            status = 'branch_selected';
            source = 'selected-swipe-native';
        }
    } else if (imported.ok && imported.state.ct === checkpointState.ct + 1) {
        canonical = preserveCanonicalBookkeeping(imported.state, checkpointState);
        status = 'branch_selected';
        source = 'selected-swipe-legacy';
    }
    const report = activeMode === 'SHADOW' ? branchReport(status, canonical, {
        ...options,
        previous: checkpointState,
        source,
        legacy: imported.ok
            ? { status: canonical === checkpointState ? 'sequence_mismatch' : 'accepted', ct: imported.state.ct, expectedCt: checkpointState.ct + 1 }
            : { status: 'pending_or_frozen', ct: checkpointState.ct },
    }) : undefined;
    const persisted = await persistBranchCommit(canonical, selected.ledger, report, { adapter, store, engine, expectedChatId: chatId });
    if (!persisted) return { status: 'persistence_error', state: store.load(), checkpoint: checkpointState, imported: false, swipeIndex: options.swipeIndex };
    if (!options.pendingSwipe) await cleanBranchControl(message, status, adapter, chatId);
    engine.diagnostics?.info?.('BRANCH_SELECTED', status === 'branch_selected'
        ? `Selected swipe ${options.swipeIndex + 1} is canonical at ct ${canonical.ct}.`
        : `Restored pre-response state at ct ${canonical.ct} for swipe ${options.swipeIndex + 1}.`);
    if (status === 'branch_selected' && sameChat(adapter, chatId)) await renderLocalGfx(message, index, { expectedChatId: chatId });
    refreshUI();
    runtimeState.chatTopology = snapshotChatTopology(adapter);
    return { status, state: canonical, checkpoint: checkpointState, imported: imported.ok, replayed: source === 'selected-swipe-native', swipeIndex: options.swipeIndex };
}

export async function handleMessageEdited(data) {
    const adapter = runtimeState.adapter;
    const store = runtimeState.store;
    const engine = runtimeState.engine;
    const activeMode = engine?.getMode?.();
    if (!runtimeState.active || !adapter || !store || !engine || !isTransactionalMode(activeMode)) return { status: 'ignored' };
    const chatId = String(adapter.getChatId?.() ?? '');
    runtimeState.gfxOverlay?.clear?.();
    const index = eventMessageIndex(data);
    const message = adapter.getChat?.()?.[index];
    if (!message || typeof message !== 'object') return { status: 'ignored' };
    // An edit creates new presentation authority. Do not replay an artifact
    // cached for the message before the user changed it.
    clearGfxCache(message);
    if (!isAssistantSlot(message)) {
        let ledger = store.loadBranchLedger({ initialize: false });
        const affected = Object.values(ledger.slots ?? {}).filter((slot) => slot.index > index && slot.status !== 'deleted').sort((a, b) => a.index - b.index);
        if (!affected.length) { runtimeState.chatTopology = snapshotChatTopology(adapter); return { status: 'ignored' }; }
        const restoreState = deepClone(affected[0].checkpoint);
        for (const slot of affected) {
            const result = invalidateAssistantEdit(ledger, { slotId: slot.slotId, messageId: slot.messageId, index: slot.index, at: Date.now(), reason: 'earlier_user_message_edited' });
            ledger = result.ledger;
        }
        const report = activeMode === 'SHADOW' ? branchReport('user_edit_rollback', restoreState, { source: 'user-message-edit', previous: store.load() }) : undefined;
        const persisted = await persistBranchCommit(restoreState, ledger, report, { adapter, store, engine, expectedChatId: chatId });
        runtimeState.chatTopology = snapshotChatTopology(adapter);
        runtimeState.gfxOverlay?.clear?.();
        if (persisted) adapter.notify?.('warning', 'ST-STATE rolled back responses after the edited user message. Regenerate from that point.');
        refreshUI();
        return { status: persisted ? 'user_edit_rollback' : 'persistence_error', state: persisted ? restoreState : store.load() };
    }
    const options = branchOptions(adapter, message, index);
    const invalidated = invalidateAssistantEdit(store.loadBranchLedger({ initialize: false }), options);
    if (!invalidated.ok || !invalidated.restoreState) return { status: 'missing_checkpoint' };
    const imported = activeMode === 'SHADOW'
        ? importLegacyState(messageText(message), { now: Date.now(), baseState: invalidated.restoreState, preserveMissingFromBase: true, mergeSparseFromBase: true, requireTurn: true, userName: adapter.getUserName?.() })
        : { ok: false };
    const canonical = imported.ok && imported.state.ct === invalidated.restoreState.ct + 1
        ? preserveCanonicalBookkeeping(imported.state, invalidated.restoreState)
        : invalidated.restoreState;
    const status = canonical === invalidated.restoreState ? 'edit_rollback' : 'edit_rebaseline';
    const replacement = checkpointAssistantSlot(invalidated.ledger, { ...options, state: invalidated.restoreState, replace: true });
    const report = activeMode === 'SHADOW' ? branchReport(status, canonical, { ...options, previous: invalidated.restoreState, source: status }) : undefined;
    const persisted = await persistBranchCommit(canonical, replacement.ledger, report, { adapter, store, engine, expectedChatId: chatId });
    if (!persisted) return { status: 'persistence_error', state: store.load() };
    await cleanBranchControl(message, status, adapter, chatId);
    if (status === 'edit_rebaseline' && sameChat(adapter, chatId)) await renderLocalGfx(message, index, { expectedChatId: chatId });
    runtimeState.chatTopology = snapshotChatTopology(adapter);
    refreshUI();
    return { status, state: canonical };
}

export async function handleMessageDeleted(data) {
    const adapter = runtimeState.adapter;
    const store = runtimeState.store;
    const engine = runtimeState.engine;
    const activeMode = engine?.getMode?.();
    if (!runtimeState.active || !adapter || !store || !engine || !isTransactionalMode(activeMode)) return { status: 'ignored' };
    const chatId = String(adapter.getChatId?.() ?? '');
    runtimeState.gfxOverlay?.clear?.();
    const currentTopology = snapshotChatTopology(adapter);
    const firstDeletedIndex = detectDeletedIndex(runtimeState.chatTopology, currentTopology, eventMessageIndex(data));
    let ledger = store.loadBranchLedger({ initialize: false });
    const affected = Object.values(ledger.slots ?? {}).filter((slot) => slot.index >= firstDeletedIndex).sort((a, b) => a.index - b.index);
    if (!affected.length) { runtimeState.chatTopology = currentTopology; return { status: 'ignored' }; }
    const restoreState = deepClone(affected[0].checkpoint);
    for (const slot of affected) {
        const result = invalidateAssistantDelete(ledger, { slotId: slot.slotId, messageId: slot.messageId, index: slot.index, at: Date.now() });
        ledger = result.ledger;
    }
    const report = activeMode === 'SHADOW' ? branchReport('delete_rollback', restoreState, { source: 'message-delete', previous: store.load() }) : undefined;
    const persisted = await persistBranchCommit(restoreState, ledger, report, { adapter, store, engine, expectedChatId: chatId });
    runtimeState.chatTopology = currentTopology;
    runtimeState.gfxOverlay?.clear?.();
    if (!persisted) return { status: 'persistence_error', state: store.load() };
    refreshUI();
    return { status: 'delete_rollback', state: restoreState };
}

export async function handleMessageSwipeDeleted(data) {
    const adapter = runtimeState.adapter;
    const store = runtimeState.store;
    const engine = runtimeState.engine;
    if (!runtimeState.active || !adapter || !store || !engine || !isTransactionalMode(engine.getMode?.())) return { status: 'ignored' };
    const chatId = String(adapter.getChatId?.() ?? '');
    runtimeState.gfxOverlay?.clear?.();
    const index = eventMessageIndex(data);
    const message = adapter.getChat?.()?.[index];
    // Provider swipe ids and indexes can be reassigned after deletion, so the
    // old per-swipe presentation cache is no longer safe to address.
    clearGfxCache(message);
    const options = branchOptions(adapter, message, index);
    const ledger = store.loadBranchLedger({ initialize: false });
    const slot = ledger.slots?.[options.slotId];
    if (!slot?.checkpoint) return { status: 'missing_checkpoint' };
    let rebuilt = checkpointAssistantSlot(ledger, { ...options, state: slot.checkpoint, replace: true });
    for (let swipeIndex = 0; swipeIndex < (message?.swipes?.length ?? 0); swipeIndex += 1) {
        if (swipeIndex === options.swipeIndex) continue;
        rebuilt = registerAssistantSwipe(rebuilt.ledger, branchOptions(adapter, message, index, swipeIndex));
    }
    const selected = prepareSwipeEvaluation(rebuilt.ledger, options);
    try { await store.saveBranchLedger(selected.ok ? selected.ledger : rebuilt.ledger, { expectedChatId: chatId }); }
    catch (error) {
        engine.diagnostics?.error?.('BRANCH_PERSISTENCE', `Swipe deletion was not persisted: ${error.message}`);
        adapter.notify?.('error', 'ST-STATE could not update the deleted swipe ledger. Rebaseline the selected branch.');
        return { status: 'persistence_error' };
    }
    runtimeState.chatTopology = snapshotChatTopology(adapter);
    return { status: 'swipe_reindexed' };
}

function bindEvents() {
    if (runtimeState.bound || !runtimeState.adapter) return;
    const adapter = runtimeState.adapter;
    try {
        adapter.on(eventName(adapter, 'MESSAGE_RECEIVED'), handleMessageReceived);
        adapter.on(eventName(adapter, 'MESSAGE_SWIPED'), handleMessageSwiped);
        adapter.on(eventName(adapter, 'MESSAGE_EDITED'), handleMessageEdited);
        adapter.on(eventName(adapter, 'MESSAGE_DELETED'), handleMessageDeleted);
        adapter.on(eventName(adapter, 'MESSAGE_SWIPE_DELETED'), handleMessageSwipeDeleted);
        adapter.on(eventName(adapter, 'CHAT_CHANGED'), () => {
            adapter.clearPrompt();
            runtimeState.gfxOverlay?.clear?.();
            runtimeState.chatTopology = snapshotChatTopology(adapter);
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
        getGfxSettings: () => ({ enabled: gfxOptions().enabled, durationMs: gfxOptions().duration }),
        setGfxSettings: async (values) => setGfxRuntimeSettings(values),
        onPreviewGfx: (kind, options) => previewLocalGfx(kind, options),
        getShadowReport: () => runtimeState.store?.getShadowReport?.(),
        getDiagnosticEvents: () => runtimeState.engine?.diagnostics?.list?.() ?? [],
        onRefresh: refreshUI,
        onRebaselineSelectedBranch: (context) => rebaselineSelectedBranch(context),
        onClearCurrentChatState: (context) => clearCurrentChatState(context),
        onRestorePreviousState: (context) => restorePreviousState(context),
    });
    if (!settingsRoot) return;
    runtimeState.ui = {
        settingsRoot,
        dashboard: settingsRoot.querySelector('.st-dashboard'),
        diagnosticEvents: settingsRoot.querySelector('.st-diagnostic-events'),
        parity: settingsRoot.querySelector('.st-shadow-parity'),
    };
    if (!runtimeState.ui.dashboard) {
        runtimeState.ui.dashboard = document.createElement('div');
        settingsRoot.append(runtimeState.ui.dashboard);
        renderReadOnlyDashboard(runtimeState.ui.dashboard, runtimeState.store.load());
    }
    ensureGfxOverlay();
    ensureQuickDashboard();
}

export async function rebaselineSelectedBranch({ expectedChatId = undefined, preserveBranchLedger = false, automatic = false } = {}) {
    const adapter = runtimeState.adapter;
    const store = runtimeState.store;
    if (!adapter || !store) throw new Error('ST-STATE runtime is unavailable');
    const chatId = expectedChatId ?? adapter.getChatId?.();
    const chatText = (adapter.getChat?.() ?? []).map((message) => messageText(message)).join('\n');
    const previous = store.load();
    const imported = importLegacyState(chatText, { now: Date.now(), baseState: previous, preserveMissingFromBase: true, mergeSparseFromBase: true, requireTurn: true, userName: adapter.getUserName?.() });
    if (!imported.ok) throw new Error(imported.diagnostics?.join('; ') || 'No usable <internal_states> block was found on the selected branch');
    const canonical = preserveCanonicalBookkeeping(imported.state, previous);
    const ledger = preserveBranchLedger ? store.loadBranchLedger?.({ initialize: false }) ?? createBranchLedger() : createBranchLedger();
    const report = branchReport(automatic ? 'automatic_branch_rebaseline' : 'manual_branch_rebaseline', canonical, { source: 'selected-branch-legacy', legacy: { status: 'baseline', ct: canonical.ct } });
    report.recoveryBackup = store.recoveryBackup?.({ state: previous }) ?? null;
    await store.saveBranchCommit(canonical, ledger, report, { expectedChatId: chatId });
    runtimeState.gfxOverlay?.clear?.();
    runtimeState.chatTopology = snapshotChatTopology(adapter);
    const partial = imported.complete ? '' : ` Preserved ${imported.missingSections.length} missing sections.`;
    if (automatic) runtimeState.engine?.diagnostics?.info?.('BRANCH_AUTO_REBASELINE', `Selected branch automatically rebaselined at ct ${canonical.ct}.`);
    return { importedDigest: imported.digest ?? canonical.head, message: `Selected branch rebaselined at ct ${canonical.ct}.${partial}` };
}

/** Restore the latest assistant slot's pre-response checkpoint before a swipe is generated. */
export async function prepareSwipeGenerationBaseline({ expectedChatId = undefined } = {}) {
    const adapter = runtimeState.adapter;
    const store = runtimeState.store;
    const engine = runtimeState.engine;
    if (!adapter || !store || !engine || !isTransactionalMode(engine.getMode?.())) return { status: 'ignored', verified: false };
    const chat = adapter.getChat?.() ?? [];
    let index = chat.length - 1;
    while (index >= 0 && !isAssistantSlot(chat[index])) index -= 1;
    if (index < 0) return { status: 'missing_slot', verified: false };
    const chatId = String(expectedChatId ?? adapter.getChatId?.() ?? '');
    const options = branchOptions(adapter, chat[index], index);
    let ledger = store.loadBranchLedger?.({ initialize: false }) ?? createBranchLedger();
    let restored = restoreAssistantCheckpoint(ledger, options);
    if (!restored.ok) {
        const inferred = inferBranchCheckpoint(adapter, index, store.load());
        if (!inferred) return { status: 'missing_checkpoint', verified: false };
        const checkpoint = checkpointAssistantSlot(ledger, { ...options, state: inferred });
        ledger = checkpoint.ledger;
        restored = restoreAssistantCheckpoint(ledger, options);
    }
    const previous = store.load();
    const report = branchReport('swipe_generation_baseline', restored.restoreState, { ...options, source: 'branch-checkpoint', previous });
    report.recoveryBackup = store.recoveryBackup?.({ state: previous }) ?? null;
    const persisted = await persistBranchCommit(restored.restoreState, restored.ledger, report, { adapter, store, engine, expectedChatId: chatId });
    if (!persisted) return { status: 'persistence_error', verified: false };
    engine.diagnostics?.info?.('SWIPE_BASELINE_READY', `Swipe generation restored the shared checkpoint at ct ${restored.restoreState.ct}.`);
    refreshUI();
    return { status: 'swipe_generation_baseline', verified: true, state: restored.restoreState, index };
}

export async function clearCurrentChatState({ expectedChatId = undefined } = {}) {
    const adapter = runtimeState.adapter;
    if (!adapter) throw new Error('ST-STATE runtime is unavailable');
    const chatId = String(expectedChatId ?? adapter.getChatId?.() ?? '');
    const metadata = adapter.getMetadata?.();
    if (!metadata || typeof metadata !== 'object') throw new Error('Current chat metadata is unavailable');
    const assertCurrentChat = () => {
        if (String(adapter.getChatId?.() ?? '') !== chatId) throw new Error('The active chat changed before state could be cleared');
    };
    assertCurrentChat();
    const previous = deepClone(metadata);
    delete metadata[EXTENSION_KEY];
    delete metadata[SHADOW_SIDECAR_KEY];
    delete metadata[BRANCH_SIDECAR_KEY];
    setChatMode(metadata, 'LEGACY', { now: Date.now() });
    try {
        assertCurrentChat();
        await adapter.saveMetadata?.();
        assertCurrentChat();
    }
    catch (error) {
        for (const key of Object.keys(metadata)) delete metadata[key];
        Object.assign(metadata, previous);
        throw error;
    }
    adapter.clearPrompt?.();
    runtimeState.gfxOverlay?.clear?.();
    runtimeState.chatTopology = snapshotChatTopology(adapter);
    return { importedDigest: 'GENESIS', message: 'Current chat state cleared. Chat mode returned to LEGACY.' };
}

export async function restorePreviousState({ expectedChatId = undefined } = {}) {
    const adapter = runtimeState.adapter;
    const store = runtimeState.store;
    if (!adapter || !store) throw new Error('ST-STATE runtime is unavailable');
    const chatId = expectedChatId ?? adapter.getChatId?.();
    const ledger = store.loadBranchLedger?.({ initialize: false }) ?? {};
    const previous = latestAssistantCheckpoint(ledger);
    const state = previous.ok ? previous.restoreState : recoverOldCheckpoint(store);
    if (!state) throw new Error('No previous state snapshot is available');
    const report = branchReport('manual_previous_restore', state, { source: 'branch-checkpoint', previous: store.load() });
    await store.saveBranchCommit(state, previous.ledger ?? ledger, report, { expectedChatId: chatId });
    runtimeState.gfxOverlay?.clear?.();
    return { importedDigest: state.head, message: `Previous state restored at ct ${state.ct}.` };
}

export function initialize() {
    if (runtimeState.engine) return runtimeState;
    const adapter = new HostAdapter();
    const diagnostics = new DiagnosticLog();
    runtimeState.adapter = adapter;
    runtimeState.store = new ChatStore(adapter);
    runtimeState.engine = new STStateEngine({ adapter, store: runtimeState.store, diagnostics });
    runtimeState.settings = ensureSettings(adapter);
    runtimeState.chatTopology = snapshotChatTopology(adapter);
    const capabilities = adapter.diagnostics();
    for (const [key, available] of Object.entries(capabilities)) if (!available && key !== 'stagingFormatterDetected') diagnostics.warn('CAPABILITY', `${key} is unavailable; affected features will remain safely disabled.`);
    bindEvents();
    if (typeof document !== 'undefined') {
        const ready = () => {
            mountUI();
            ensureGfxOverlay();
            ensureQuickDashboard();
        };
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
    if (normalized === 'SHADOW' || normalized === 'NATIVE') requireCurrentShadowBaseline(adapter, () => store.load({ initialize: false }), `enabling ${normalized === 'NATIVE' ? 'Hybrid Native' : 'Shadow'} mode`);
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
    runtimeState.gfxOverlay?.clear?.();
    refreshUI();
    return selected;
}

export async function setGlobalRuntimeMode(mode) {
    const adapter = runtimeState.adapter ?? new HostAdapter();
    if (!runtimeState.adapter) runtimeState.adapter = adapter;
    const settings = adapter.getSettings?.();
    const normalized = normalizeEngineMode(mode);
    const store = runtimeState.store ?? new ChatStore(adapter);
    if (normalized === 'SHADOW' || normalized === 'NATIVE') requireCurrentShadowBaseline(adapter, () => store.load({ initialize: false }), `making ${normalized === 'NATIVE' ? 'Hybrid Native' : 'Shadow'} the default`);
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
    runtimeState.gfxOverlay?.clear?.();
    refreshUI();
    return selected;
}

export async function setGfxRuntimeSettings({ enabled = true, durationMs = 7000 } = {}) {
    const adapter = runtimeState.adapter ?? new HostAdapter();
    if (!runtimeState.adapter) runtimeState.adapter = adapter;
    const rootSettings = adapter.getSettings?.();
    const record = ensureSettings(adapter);
    if (!rootSettings || !record) throw new Error('Extension settings are unavailable');
    const previous = deepClone(record);
    record.gfxEnabled = enabled !== false;
    const duration = Number(durationMs);
    record.gfxDurationMs = Number.isFinite(duration) ? Math.max(2000, Math.min(20000, Math.trunc(duration))) : 7000;
    try { await adapter.saveSettingsDebounced?.(); }
    catch (error) {
        Object.assign(record, previous);
        runtimeState.engine?.diagnostics?.warn?.('GFX_SETTINGS_SAVE', `Could not persist local GFX settings: ${error.message}`);
        throw error;
    }
    ensureGfxOverlay()?.configure?.(gfxOptions(adapter));
    return { enabled: record.gfxEnabled, durationMs: record.gfxDurationMs };
}

const GFX_PREVIEW_FIXTURES = Object.freeze({
    terminal: { title: 'Secure terminal', source: 'Relay', rows: [{ role: 'system', label: 'STATUS', text: 'Connection verified.' }, { role: 'item', label: '>', text: 'Awaiting command.' }] },
    phone: { title: 'Messages', source: 'Mara', rows: [{ role: 'received', label: 'Mara', text: 'You seeing this?' }, { role: 'sent', label: 'You', text: 'Yeah. Keep the line open.' }] },
    paper: { title: 'Folded note', source: 'Mara', rows: [{ label: 'Message', text: 'Meet me where the river bends.' }] },
    map: { title: 'Field map', source: 'Survey desk', rows: [{ label: 'Route', text: 'North bridge → Old mill → Safehouse' }] },
    notice: { title: 'Public notice', source: 'Civic hall', rows: [{ label: 'Notice', text: 'Curfew begins at sundown.' }] },
    credential: { title: 'Access credential', source: 'Gate system', rows: [{ label: 'Holder', text: 'Mara Voss' }, { label: 'Clearance', text: 'Level 2' }] },
    transaction: { title: 'Transaction record', source: 'Ledger', rows: [{ label: 'Amount', text: '12 credits' }, { label: 'Status', text: 'Approved' }] },
    web: { title: 'Local bulletin', source: 'Public web', rows: [{ label: 'Headline', text: 'Transit resumes after midnight.' }] },
    broadcast: { title: 'Emergency broadcast', source: 'Channel 7', rows: [{ label: 'Message', text: 'Remain indoors until the all-clear.' }] },
    data: { title: 'Data readout', source: 'Sensor array', rows: [{ label: 'Signal', text: '86% stable' }, { label: 'Range', text: '400 meters' }] },
    image: { title: 'Recovered image', source: 'Camera roll', rows: [{ label: 'Caption', text: 'A blurred figure at the east gate.' }] },
    monitor: { title: 'Monitor status', source: 'Control room', rows: [{ label: 'Temperature', text: '21 C' }, { label: 'Alert', text: 'No active alarms' }] },
    media: { title: 'Media clip', source: 'Archive', rows: [{ label: 'Transcript', text: 'The recording begins with a door closing.' }] },
});

export function previewLocalGfx(kind = 'paper', options = {}) {
    const requested = String(kind ?? '').toLowerCase();
    const selected = GFX_MEDIA_KINDS.includes(requested) ? requested : 'paper';
    const overlay = ensureGfxOverlay();
    if (!overlay) return null;
    const fixture = GFX_PREVIEW_FIXTURES[selected] ?? GFX_PREVIEW_FIXTURES.paper;
    const phonePlatform = String(options.platform ?? 'ios').toLowerCase() === 'android' ? 'android' : 'ios';
    const phoneFixture = phonePlatform === 'android' ? {
        platform: 'android',
        layout: options.layout ?? 'chat',
        title: 'Weekend plans (5)',
        source: undefined,
        meta: { time: '09:41', battery: 'LTE 82%' },
        rows: [
            { role: 'received', label: 'Niko', time: '09:38', text: 'Platform confirmed. Meet by the west entrance.' },
            { role: 'received', label: 'Mara', time: '09:39', text: 'I have the tickets and the route.' },
            { role: 'received', label: 'Ari', time: '09:40', text: 'Running five minutes late.' },
            { role: 'sent', label: 'You', time: '09:40', text: 'No problem. Keep the group posted.' },
            { role: 'received', label: 'Niko', time: '09:41', text: 'Copy that.' },
            { role: 'system', time: '09:41', text: 'Mara changed the group description.' },
        ],
    } : {
        platform: 'ios',
        layout: options.layout ?? 'chat',
        title: 'Weekend plans (5)',
        source: undefined,
        meta: { time: '09:41', battery: 'Wi-Fi 87%' },
        rows: [
            { role: 'received', label: 'Niko', time: '09:38', text: 'Platform confirmed. Meet by the west entrance.' },
            { role: 'received', label: 'Mara', time: '09:39', text: 'I have the tickets and the route.' },
            { role: 'received', label: 'Ari', time: '09:40', text: 'Running five minutes late.' },
            { role: 'sent', label: 'You', time: '09:40', text: 'No problem. Keep the group posted.' },
            { role: 'received', label: 'Niko', time: '09:41', text: 'Copy that.' },
            { role: 'system', time: '09:41', text: 'Mara changed the group description.' },
        ],
    };
    const event = {
        ...deepClone(fixture),
        id: `preview-${selected}-${Date.now()}`,
        kind: selected,
        visibility: 'public',
        ...(selected === 'phone' ? phoneFixture : {}),
    };
    overlay.replaceBranch?.(`preview:${selected}:${Date.now()}`, [event]);
    return event;
}

export function previewLocalPhoneGfx(platform = 'ios') {
    return previewLocalGfx('phone', { platform });
}

export async function stStateGenerateInterceptor(chat, _contextSize, abort, type = 'normal') {
    if (!runtimeState.engine) initialize();
    if (!runtimeState.engine || !runtimeState.active) return;
    runtimeState.adapter?.noteGenerationType?.(type);
    const chatArray = Array.isArray(chat) ? chat : [];
    const latestUser = [...chatArray].reverse().find((message) => message?.is_user === true || message?.role === 'user');
    const bootstrapNpcNames = [...new Set([
        ...chatArray.filter((message) => message?.is_user !== true && message?.role !== 'user')
            .map((message) => String(message?.name ?? message?.character_name ?? '').trim()),
        runtimeState.adapter?.getCharacterName?.(),
    ].filter(Boolean))].slice(0, 12);
    const generationType = String(type ?? 'normal').trim().toLowerCase();
    let verifiedBranchBaseline = false;
    const activeMode = runtimeState.engine.getMode?.();
    if (isTransactionalMode(activeMode)) {
        try {
            if (generationType === 'swipe') {
                const prepared = await prepareSwipeGenerationBaseline({ expectedChatId: runtimeState.adapter?.getChatId?.() });
                verifiedBranchBaseline = prepared.verified === true;
                if (!verifiedBranchBaseline) {
                    const message = `${activeMode === 'NATIVE' ? 'Hybrid Native' : 'Shadow'} swipe generation needs a reconstructable pre-response branch checkpoint.`;
                    runtimeState.adapter?.clearPrompt?.();
                    runtimeState.engine.diagnostics?.warn?.('SWIPE_BASELINE_REQUIRED', message, prepared);
                    runtimeState.adapter?.notify?.('warning', `ST-STATE cancelled generation: ${message}`);
                    abort?.(true);
                    return { injected: false, skipped: true, type: generationType, mode: activeMode, reason: 'branch_checkpoint_required', branch: prepared };
                }
            } else if (activeMode === 'SHADOW') {
                const baseline = inspectShadowBaseline(runtimeState.adapter, runtimeState.store?.load?.({ initialize: false }));
                if (baseline.status === 'stale') {
                    await rebaselineSelectedBranch({ expectedChatId: runtimeState.adapter?.getChatId?.(), preserveBranchLedger: true, automatic: true });
                }
            }
        } catch (error) {
            runtimeState.adapter?.clearPrompt?.();
            runtimeState.engine.diagnostics?.warn?.('AUTO_REBASELINE_FAILED', `Automatic branch rebaseline failed: ${error.message}`);
            runtimeState.adapter?.notify?.('warning', `ST-STATE cancelled generation: ${error.message}`);
            abort?.(true);
            return { injected: false, skipped: true, type: generationType, mode: activeMode, reason: 'automatic_rebaseline_failed', error };
        }
    }
    const result = await runtimeState.engine.injectPrompt(type, {
        userText: latestUser ? messageText(latestUser) : runtimeState.engine.latestUserText(),
        bootstrapNpcNames,
        verifiedBranchBaseline,
    });
    if (result?.mode === 'SHADOW' && ['baseline_required', 'baseline_stale'].includes(result?.reason)) abort?.(true);
    return result;
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
    ensureGfxOverlay();
    const quick = ensureQuickDashboard();
    if (quick?.launcher) quick.launcher.hidden = false;
}
export function onDisable() {
    runtimeState.active = false;
    runtimeState.adapter?.clearPrompt();
    runtimeState.gfxOverlay?.clear?.();
    const quick = runtimeState.quickDashboard;
    if (quick) {
        setQuickDashboardOpen(quick, false);
        quick.launcher.hidden = true;
    }
}

