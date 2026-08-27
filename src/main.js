import { HostAdapter } from './adapter.js';
import { ChatStore } from './store.js';
import { preserveCanonicalBookkeeping, recordControlMetadata, STStateEngine } from './engine.js';
import { DiagnosticLog } from './diagnostics.js';
import { mountSettingsUI, renderDiagnosticEvents, renderReadOnlyDashboard } from './ui.js';
import { stableMessageIdentity } from './identity.js';
import { extractHiddenPatch, messageText, removeControlPayload, stripMessageControlPayload } from './patch.js';
import { CHAT_CONFIG_KEY, DEFAULT_ENGINE_MODE, ENGINE_MODES, SETTINGS_KEY, ensureGlobalSettings, getChatMode, getGlobalDefaultMode, normalizeEngineMode, setChatMode, setGlobalDefaultMode } from './modes.js';
import { deepClone, stableHash } from './util.js';
import { importLegacyState } from './legacy.js';
import { BRANCH_SIDECAR_KEY, checkpointAssistantSlot, createBranchLedger, invalidateAssistantDelete, invalidateAssistantEdit, latestAssistantCheckpoint, prepareSwipeEvaluation, registerAssistantSwipe, stableSwipeIdentity } from './branch.js';
import { EXTENSION_KEY } from './schema.js';
import { SHADOW_SIDECAR_KEY } from './modes.js';

export const runtimeState = {
    adapter: null,
    store: null,
    engine: null,
    settings: null,
    active: true,
    bound: false,
    ui: null,
    chatTopology: [],
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
    const contentHash = stableHash(removeControlPayload(target.text));
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

export async function handleMessageReceived(data) {
    if (!runtimeState.active) return;
    const adapter = runtimeState.adapter;
    const engine = runtimeState.engine;
    if (!adapter || !engine) return;
    const message = resolveEventMessage(adapter, data);
    if (!isAssistantMessage(message)) return;
    const index = messageIndex(adapter, message, data);
    const chatId = adapter.getChatId();
    const branchActive = engine.getMode?.() === 'SHADOW';
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
            const selected = prepareSwipeEvaluation(runtimeState.store.loadBranchLedger(), options);
            if (selected.ok) await runtimeState.store.saveBranchLedger(selected.ledger, { expectedChatId: chatId });
        } catch (error) {
            engine.diagnostics?.warn?.('BRANCH_SELECT', `Could not record the selected swipe: ${error.message}`);
        }
    }
    if (attachedIdentity && result.status === 'missing') {
        try { await adapter.saveChat(); } catch { /* message identity is a best-effort branch aid */ }
    }
    runtimeState.chatTopology = snapshotChatTopology(adapter);
    refreshUI();
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

async function cleanBranchControl(message, status, adapter) {
    const extracted = extractHiddenPatch(messageText(message));
    if (!extracted.controlBearing) return;
    recordControlMetadata(message, extracted, { status, mode: 'SHADOW' }, Date.now());
    stripMessageControlPayload(message);
    try { await adapter.saveChat?.(); } catch { /* metadata authority is already safe */ }
}

async function persistBranchCommit(state, ledger, report, { adapter, store, engine }) {
    const targetChatId = String(adapter.getChatId?.() ?? '');
    try {
        await store.saveBranchCommit(state, ledger, report, { expectedChatId: targetChatId });
        return true;
    } catch (error) {
        engine.diagnostics?.error?.('BRANCH_PERSISTENCE', `Branch state was not persisted: ${error.message}`);
        adapter.clearPrompt?.();
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

/** Restore the common pre-response checkpoint, then adopt the selected swipe if complete. */
export async function handleMessageSwiped(data) {
    const adapter = runtimeState.adapter;
    const store = runtimeState.store;
    const engine = runtimeState.engine;
    if (!runtimeState.active || !adapter || !store || !engine || engine.getMode?.() !== 'SHADOW') return { status: 'ignored' };
    const index = eventMessageIndex(data);
    const message = adapter.getChat?.()?.[index];
    if (!isAssistantSlot(message)) return { status: 'ignored' };
    const options = branchOptions(adapter, message, index);
    let ledger = store.loadBranchLedger?.({ initialize: false });
    let selected = prepareSwipeEvaluation(ledger, options);
    if (!selected.ok) {
        const fallback = recoverOldCheckpoint(store);
        if (!fallback) {
            engine.diagnostics?.warn?.('BRANCH_BASELINE', 'No pre-response checkpoint exists for this swipe. Use Rebaseline selected branch.');
            adapter.notify?.('warning', 'ST-STATE needs Rebaseline selected branch for this older swipe.');
            return { status: 'missing_checkpoint' };
        }
        const checkpoint = checkpointAssistantSlot(ledger, { ...options, state: fallback });
        ledger = checkpoint.ledger;
        selected = prepareSwipeEvaluation(ledger, options);
    }
    const checkpointState = selected.restoreState;
    const imported = options.pendingSwipe ? { ok: false, diagnostics: ['Pending overswipe'] } : importLegacyState(options.selectedText, {
        now: Date.now(),
        baseState: checkpointState,
        requireComplete: true,
        userName: adapter.getUserName?.(),
    });
    let canonical = checkpointState;
    let status = 'branch_checkpoint';
    let source = 'branch-checkpoint';
    if (imported.ok && imported.state.ct === checkpointState.ct + 1) {
        canonical = preserveCanonicalBookkeeping(imported.state, checkpointState);
        status = 'branch_selected';
        source = 'selected-swipe-legacy';
    }
    const report = branchReport(status, canonical, {
        ...options,
        previous: checkpointState,
        source,
        legacy: imported.ok
            ? { status: canonical === checkpointState ? 'sequence_mismatch' : 'accepted', ct: imported.state.ct, expectedCt: checkpointState.ct + 1 }
            : { status: 'pending_or_frozen', ct: checkpointState.ct },
    });
    const persisted = await persistBranchCommit(canonical, selected.ledger, report, { adapter, store, engine });
    if (!persisted) return { status: 'persistence_error', state: store.load(), checkpoint: checkpointState, imported: false, swipeIndex: options.swipeIndex };
    if (!options.pendingSwipe) await cleanBranchControl(message, status, adapter);
    engine.diagnostics?.info?.('BRANCH_SELECTED', status === 'branch_selected'
        ? `Selected swipe ${options.swipeIndex + 1} is canonical at ct ${canonical.ct}.`
        : `Restored pre-response state at ct ${canonical.ct} for swipe ${options.swipeIndex + 1}.`);
    refreshUI();
    runtimeState.chatTopology = snapshotChatTopology(adapter);
    return { status, state: canonical, checkpoint: checkpointState, imported: imported.ok, swipeIndex: options.swipeIndex };
}

export async function handleMessageEdited(data) {
    const adapter = runtimeState.adapter;
    const store = runtimeState.store;
    const engine = runtimeState.engine;
    if (!runtimeState.active || !adapter || !store || !engine || engine.getMode?.() !== 'SHADOW') return { status: 'ignored' };
    const index = eventMessageIndex(data);
    const message = adapter.getChat?.()?.[index];
    if (!message || typeof message !== 'object') return { status: 'ignored' };
    if (!isAssistantSlot(message)) {
        let ledger = store.loadBranchLedger({ initialize: false });
        const affected = Object.values(ledger.slots ?? {}).filter((slot) => slot.index > index && slot.status !== 'deleted').sort((a, b) => a.index - b.index);
        if (!affected.length) { runtimeState.chatTopology = snapshotChatTopology(adapter); return { status: 'ignored' }; }
        const restoreState = deepClone(affected[0].checkpoint);
        for (const slot of affected) {
            const result = invalidateAssistantEdit(ledger, { slotId: slot.slotId, messageId: slot.messageId, index: slot.index, at: Date.now(), reason: 'earlier_user_message_edited' });
            ledger = result.ledger;
        }
        const persisted = await persistBranchCommit(restoreState, ledger, branchReport('user_edit_rollback', restoreState, { source: 'user-message-edit', previous: store.load() }), { adapter, store, engine });
        runtimeState.chatTopology = snapshotChatTopology(adapter);
        if (persisted) adapter.notify?.('warning', 'ST-STATE rolled back responses after the edited user message. Regenerate from that point.');
        refreshUI();
        return { status: persisted ? 'user_edit_rollback' : 'persistence_error', state: persisted ? restoreState : store.load() };
    }
    const options = branchOptions(adapter, message, index);
    const invalidated = invalidateAssistantEdit(store.loadBranchLedger({ initialize: false }), options);
    if (!invalidated.ok || !invalidated.restoreState) return { status: 'missing_checkpoint' };
    const imported = importLegacyState(messageText(message), { now: Date.now(), baseState: invalidated.restoreState, requireComplete: true, userName: adapter.getUserName?.() });
    const canonical = imported.ok && imported.state.ct === invalidated.restoreState.ct + 1
        ? preserveCanonicalBookkeeping(imported.state, invalidated.restoreState)
        : invalidated.restoreState;
    const status = canonical === invalidated.restoreState ? 'edit_rollback' : 'edit_rebaseline';
    const replacement = checkpointAssistantSlot(invalidated.ledger, { ...options, state: invalidated.restoreState, replace: true });
    const persisted = await persistBranchCommit(canonical, replacement.ledger, branchReport(status, canonical, { ...options, previous: invalidated.restoreState, source: status }), { adapter, store, engine });
    if (!persisted) return { status: 'persistence_error', state: store.load() };
    await cleanBranchControl(message, status, adapter);
    runtimeState.chatTopology = snapshotChatTopology(adapter);
    refreshUI();
    return { status, state: canonical };
}

export async function handleMessageDeleted(data) {
    const adapter = runtimeState.adapter;
    const store = runtimeState.store;
    const engine = runtimeState.engine;
    if (!runtimeState.active || !adapter || !store || !engine || engine.getMode?.() !== 'SHADOW') return { status: 'ignored' };
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
    const persisted = await persistBranchCommit(restoreState, ledger, branchReport('delete_rollback', restoreState, { source: 'message-delete', previous: store.load() }), { adapter, store, engine });
    runtimeState.chatTopology = currentTopology;
    if (!persisted) return { status: 'persistence_error', state: store.load() };
    refreshUI();
    return { status: 'delete_rollback', state: restoreState };
}

export async function handleMessageSwipeDeleted(data) {
    const adapter = runtimeState.adapter;
    const store = runtimeState.store;
    const engine = runtimeState.engine;
    if (!runtimeState.active || !adapter || !store || !engine || engine.getMode?.() !== 'SHADOW') return { status: 'ignored' };
    const index = eventMessageIndex(data);
    const message = adapter.getChat?.()?.[index];
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
    try { await store.saveBranchLedger(selected.ok ? selected.ledger : rebuilt.ledger, { expectedChatId: adapter.getChatId?.() }); }
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
    };
    if (!runtimeState.ui.dashboard) {
        runtimeState.ui.dashboard = document.createElement('div');
        settingsRoot.append(runtimeState.ui.dashboard);
        renderReadOnlyDashboard(runtimeState.ui.dashboard, runtimeState.store.load());
    }
}

export async function rebaselineSelectedBranch({ expectedChatId = undefined } = {}) {
    const adapter = runtimeState.adapter;
    const store = runtimeState.store;
    if (!adapter || !store) throw new Error('ST-STATE runtime is unavailable');
    const chatId = expectedChatId ?? adapter.getChatId?.();
    const chatText = (adapter.getChat?.() ?? []).map((message) => messageText(message)).join('\n');
    const previous = store.load();
    const imported = importLegacyState(chatText, { now: Date.now(), baseState: previous, requireComplete: true, userName: adapter.getUserName?.() });
    if (!imported.ok) throw new Error(imported.diagnostics?.join('; ') || 'No complete <internal_states> block was found on the selected branch');
    const canonical = preserveCanonicalBookkeeping(imported.state, previous);
    const ledger = createBranchLedger();
    const report = branchReport('manual_branch_rebaseline', canonical, { source: 'selected-branch-legacy', legacy: { status: 'baseline', ct: canonical.ct } });
    await store.saveBranchCommit(canonical, ledger, report, { expectedChatId: chatId });
    runtimeState.chatTopology = snapshotChatTopology(adapter);
    return { importedDigest: imported.digest ?? canonical.head, message: `Selected branch rebaselined at ct ${canonical.ct}.` };
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

