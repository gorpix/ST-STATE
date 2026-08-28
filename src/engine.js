import { ChatSwitchError } from './store.js';
import { applyTransaction } from './reducer.js';
import { buildProtocolPrompt } from './selector.js';
import { extractHiddenPatch, messageText, stripMessageControlPayload } from './patch.js';
import { transactionIdentity } from './identity.js';
import { importLegacyState } from './legacy.js';
import { DiagnosticLog } from './diagnostics.js';
import { CHAT_CONFIG_KEY, DEFAULT_ENGINE_MODE, ENGINE_MODES, getChatMode, getGlobalDefaultMode, normalizeEngineMode } from './modes.js';
import { compareShadowParity, makeShadowSidecar } from './shadow.js';
import { deepClone, sanitizePlainText } from './util.js';

export const SKIP_GENERATION_TYPES = new Set(['quiet', 'impersonate', 'continue']);

export function recordControlMetadata(message, extracted, result, at) {
    if (!message || typeof message !== 'object') return;
    if (!message.extra || typeof message.extra !== 'object' || Array.isArray(message.extra)) message.extra = {};
    const record = {
        version: 1,
        at,
        status: result?.status ?? 'unknown',
        flashHandoff: extracted?.flashHandoff === true,
        mode: result?.mode ?? undefined,
    };
    if (record.mode === undefined) delete record.mode;
    if (extracted?.patch) record.patch = deepClone(extracted.patch);
    if (extracted?.error) record.error = sanitizePlainText(extracted.error, { maxLength: 1000, preserveNewlines: false });
    if (result?.transactionId) record.transactionId = sanitizePlainText(result.transactionId, { maxLength: 200, preserveNewlines: false });
    if (Array.isArray(result?.errors) && result.errors.length) record.errors = result.errors.map((error) => sanitizePlainText(error, { maxLength: 1000, preserveNewlines: false }));
    message.extra.stState = record;
}

function requestedMode(adapter) {
    const metadata = adapter?.getMetadata?.() ?? null;
    const settings = adapter?.getSettings?.() ?? null;
    const requested = metadata?.[CHAT_CONFIG_KEY]?.mode;
    if (String(requested ?? '').trim().toUpperCase() === 'NATIVE') return 'NATIVE';
    return getChatMode(metadata, settings);
}

function canonicalMode(adapter) {
    const requested = requestedMode(adapter);
    return requested === 'NATIVE' ? DEFAULT_ENGINE_MODE : normalizeEngineMode(requested);
}

export function preserveCanonicalBookkeeping(imported, previous) {
    imported.history = deepClone(previous.history ?? []);
    imported.dedupe = deepClone(previous.dedupe ?? []);
    imported.branches = deepClone(previous.branches ?? imported.branches);
    imported.meta.createdAt = previous.meta?.createdAt ?? imported.meta.createdAt;
    return imported;
}

function hasCanonicalBaseline(state) {
    return String(state?.head ?? state?.meta?.head ?? 'GENESIS') !== 'GENESIS'
        || Number(state?.ct ?? state?.meta?.ct ?? 0) > 0
        || Object.keys(state?.actors ?? {}).length > 0
        || Boolean(state?.opaque?.legacy?.internalStatesRaw);
}

function chatContainsLegacy(adapter) {
    return (adapter?.getChat?.() ?? []).some((message) => /<internal_states\b/i.test(messageText(message)));
}

function chatLegacyText(adapter) {
    return (adapter?.getChat?.() ?? []).map((message) => messageText(message)).join('\n');
}

export function inspectShadowBaseline(adapter, state, { now = Date.now() } = {}) {
    if (!chatContainsLegacy(adapter)) return { status: 'no_legacy', ready: true };
    if (!hasCanonicalBaseline(state)) return { status: 'missing', ready: false };
    const imported = importLegacyState(chatLegacyText(adapter), {
        now,
        baseState: state,
        requireComplete: true,
        userName: adapter?.getUserName?.(),
    });
    if (!imported.ok) {
        return {
            status: 'incomplete',
            ready: false,
            diagnostics: deepClone(imported.diagnostics ?? []),
        };
    }
    const canonical = {
        ct: Number(state?.ct ?? state?.meta?.ct ?? 0),
        head: String(state?.head ?? state?.meta?.head ?? 'GENESIS'),
    };
    const legacy = { ct: imported.state.ct, head: imported.state.head };
    const ready = canonical.ct === legacy.ct && canonical.head === legacy.head;
    return { status: ready ? 'current' : 'stale', ready, canonical, legacy };
}

export class STStateEngine {
    constructor({ adapter, store, diagnostics = new DiagnosticLog(), now = () => Date.now(), modeResolver = null } = {}) {
        this.adapter = adapter;
        this.store = store;
        this.diagnostics = diagnostics;
        this.now = now;
        this.modeResolver = modeResolver;
        this.processing = Promise.resolve();
    }

    loadState(options = {}) {
        return this.store.load(options);
    }

    getMode() {
        const requested = this.modeResolver?.();
        if (requested) return String(requested).trim().toUpperCase();
        return canonicalMode(this.adapter);
    }

    getRequestedMode() {
        return requestedMode(this.adapter);
    }

    buildPrompt(options = {}) {
        const state = this.loadState({ initialize: false });
        const userText = options.userText ?? this.latestUserText();
        const mode = String(options.mode ?? this.getMode()).trim().toUpperCase();
        return buildProtocolPrompt(state, { ...options, userText, mode });
    }

    latestUserText() {
        const chat = this.adapter?.getChat?.() ?? [];
        for (let index = chat.length - 1; index >= 0; index -= 1) {
            const message = chat[index];
            if (message?.is_user === true || message?.role === 'user') return messageText(message);
        }
        return '';
    }

    async injectPrompt(type = 'normal', options = {}) {
        const generationType = String(type ?? 'normal').toLowerCase();
        const mode = this.getMode();
        if (SKIP_GENERATION_TYPES.has(generationType)) {
            this.adapter.clearPrompt();
            return { injected: false, skipped: true, type: generationType, mode };
        }
        if (mode !== 'SHADOW') {
            this.adapter.clearPrompt();
            const reason = mode === 'LEGACY' ? 'legacy_mode' : mode === 'RECOVERY' ? 'recovery_mode' : 'native_locked';
            this.diagnostics.info('MODE_NO_INJECT', `Prompt injection disabled in ${mode} mode`);
            return { injected: false, skipped: true, type: generationType, mode, reason };
        }
        const state = this.loadState({ initialize: false });
        const baseline = inspectShadowBaseline(this.adapter, state, { now: this.now() });
        if (baseline.status === 'missing' || baseline.status === 'incomplete') {
            this.adapter.clearPrompt();
            this.diagnostics.warn('BASELINE_REQUIRED', 'Import the latest complete legacy state before Shadow prompt injection.');
            return { injected: false, skipped: true, type: generationType, mode, reason: 'baseline_required', baseline };
        }
        if (baseline.status === 'stale') {
            this.adapter.clearPrompt();
            const mismatch = baseline.canonical.ct === baseline.legacy.ct
                ? `Canonical state differs from the selected branch at ct ${baseline.canonical.ct}`
                : `Canonical ct ${baseline.canonical.ct} does not match selected branch ct ${baseline.legacy.ct}`;
            const message = `${mismatch}. Rebaseline selected branch before generating.`;
            this.diagnostics.warn('BASELINE_STALE', message, baseline);
            this.adapter.notify?.('warning', `ST-STATE blocked generation: ${message}`);
            return { injected: false, skipped: true, type: generationType, mode, reason: 'baseline_stale', baseline };
        }
        try {
            const prompt = this.buildPrompt({ ...options, mode });
            this.adapter.setPrompt(prompt.text);
            this.diagnostics.info('PROMPT_INJECTED', `Shadow protocol injected for ${generationType}`, { selected: prompt.selection.selectedActorIds, mode });
            return { injected: true, skipped: false, type: generationType, mode, selection: prompt.selection, text: prompt.text };
        } catch (error) {
            this.diagnostics.warn('PROMPT_UNAVAILABLE', `Prompt injection unavailable: ${error.message}`);
            return { injected: false, skipped: false, mode, error };
        }
    }

    processAssistantMessage(message, { index = -1, messageIdentity = '', expectedChatId = undefined, mode = undefined } = {}) {
        // Queue processing so two event hooks cannot both pass the same base
        // check before either one persists an authoritative import.
        const task = this.processing.then(() => this._processAssistantMessage(message, { index, messageIdentity, expectedChatId, mode }));
        this.processing = task.catch(() => undefined);
        return task;
    }

    async _processAssistantMessage(message, { index = -1, messageIdentity = '', expectedChatId = undefined, mode = undefined } = {}) {
        const raw = messageText(message);
        const activeMode = String(mode ?? this.getMode()).trim().toUpperCase();
        if (activeMode === 'LEGACY') {
            this.diagnostics.info('LEGACY_MODE', 'Legacy mode leaves canonical state and message controls untouched.', { messageIndex: index });
            return { status: 'legacy', mode: activeMode, state: this.loadState(), displayText: raw, extracted: null, persisted: false };
        }
        if (activeMode === 'RECOVERY') {
            this.diagnostics.info('RECOVERY_MODE', 'Recovery mode is read-only for incoming turns.', { messageIndex: index });
            return { status: 'recovery_read_only', mode: activeMode, state: this.loadState(), displayText: raw, extracted: null, persisted: false };
        }
        if (activeMode === 'NATIVE' || this.getRequestedMode() === 'NATIVE') {
            this.diagnostics.warn('NATIVE_LOCKED', 'Native mode is locked in this evaluator; no incoming turn was processed.', { messageIndex: index });
            return { status: 'native_locked', mode: 'NATIVE', state: this.loadState(), displayText: raw, extracted: null, persisted: false };
        }
        return this._processShadowMessage(message, { index, messageIdentity, expectedChatId, raw });
    }

    async _processShadowMessage(message, { index = -1, messageIdentity = '', expectedChatId = undefined, raw }) {
        const extracted = extractHiddenPatch(raw);
        const state = this.loadState();
        const identity = messageIdentity || `message:${index}`;
        const targetChatId = expectedChatId === undefined ? this.adapter.getChatId?.() : expectedChatId;

        // OOC, FLASH, and an explicit handoff freeze both the authoritative
        // import and the candidate. This is checked before touching metadata.
        if (extracted.flashHandoff || (extracted.ok && ['OOC', 'FLASH'].includes(extracted.patch.mode))) {
            const result = { status: 'ignored', reason: extracted.flashHandoff ? 'flash_handoff' : extracted.patch.mode.toLowerCase(), mode: 'SHADOW', state, persisted: false };
            this.diagnostics.info('PATCH_IGNORED', `Shadow ${result.reason} response did not mutate state`);
            if (extracted.controlBearing) {
                recordControlMetadata(message, extracted, result, this.now());
                stripMessageControlPayload(message);
                try { await this.adapter.saveChat?.({ expectedChatId: targetChatId }); } catch { /* display cleanup is best effort */ }
            }
            return { ...result, displayText: extracted.prose, extracted };
        }

        const importedResult = importLegacyState(raw, { now: this.now(), baseState: state, requireComplete: true, userName: this.adapter?.getUserName?.() });
        if (!importedResult.ok) {
            this.diagnostics.warn('SHADOW_LEGACY_MISSING', 'Shadow mode requires a complete <internal_states> block; canonical state was kept unchanged.', { messageIndex: index });
            const result = { status: 'missing_legacy', mode: 'SHADOW', state, displayText: extracted.found ? extracted.prose : raw, extracted, persisted: false };
            recordControlMetadata(message, extracted, result, this.now());
            if (extracted.controlBearing) {
                stripMessageControlPayload(message);
                try { await this.adapter.saveChat?.({ expectedChatId: targetChatId }); } catch { /* rejection cleanup is best effort */ }
            }
            return result;
        }

        const authoritative = preserveCanonicalBookkeeping(importedResult.state, state);
        const hasBaseline = hasCanonicalBaseline(state);
        if (hasBaseline && authoritative.ct !== state.ct + 1) {
            const parity = compareShadowParity(authoritative, null, { patchStatus: extracted.found ? (extracted.ok ? 'not_evaluated' : 'malformed') : 'missing', at: this.now() });
            const sidecar = {
                ...makeShadowSidecar(parity, { messageId: identity, at: this.now() }),
                status: 'sequence_mismatch',
                previous: { ct: state.ct, head: state.head },
                legacy: { status: 'sequence_mismatch', ct: authoritative.ct, head: authoritative.head, expectedCt: state.ct + 1 },
                canonical: { source: 'unchanged', persisted: false, ct: state.ct, head: state.head },
            };
            try { await this.store.saveShadowReport?.(sidecar, { expectedChatId: targetChatId }); } catch (error) { this.diagnostics.warn('SHADOW_REPORT', `Could not persist sequence diagnostic: ${error.message}`); }
            const mismatch = { status: 'legacy_sequence_mismatch', mode: 'SHADOW', state, displayText: extracted.found ? extracted.prose : raw, extracted, parity: sidecar, persisted: false };
            recordControlMetadata(message, extracted, mismatch, this.now());
            if (extracted.controlBearing) {
                stripMessageControlPayload(message);
                try { await this.adapter.saveChat?.({ expectedChatId: targetChatId }); } catch { /* rejection cleanup is best effort */ }
            }
            this.diagnostics.warn('SHADOW_SEQUENCE', `Legacy turn ${authoritative.ct} did not follow canonical turn ${state.ct}; canonical state was kept unchanged.`);
            return mismatch;
        }

        let result;
        if (!extracted.found) result = { status: 'missing', errors: ['No ST_PATCH comment was found'] };
        else if (!extracted.ok) result = { status: 'malformed', errors: [extracted.error || 'ST_PATCH JSON is invalid'] };
        else {
            result = applyTransaction(state, extracted.patch, {
                messageIdentity: identity,
                flashHandoff: extracted.flashHandoff,
                now: this.now(),
            });
        }
        const candidate = result.status === 'committed' ? result.state : null;
        const parity = compareShadowParity(authoritative, candidate, { patchStatus: result.status, at: this.now(), patch: result.patch ?? extracted.patch });
        const sidecar = makeShadowSidecar(parity, {
            transactionId: result.transactionId || (extracted.patch ? transactionIdentity(extracted.patch, identity) : ''),
            messageId: identity,
            at: this.now(),
        });
        sidecar.previous = { ct: state.ct, head: state.head };
        sidecar.legacy = { status: hasBaseline ? 'accepted' : 'baseline', ct: authoritative.ct, head: authoritative.head };
        sidecar.patch = { status: result.status, base: extracted.patch?.base ?? null, tx: extracted.patch?.tx ?? null, opsCount: extracted.patch?.ops?.length ?? 0, errors: deepClone(result.errors ?? []) };
        sidecar.canonical = { source: 'legacy', persisted: false, ct: authoritative.ct, head: authoritative.head };
        sidecar.recoveryBackup = typeof this.store.recoveryBackup === 'function' ? this.store.recoveryBackup({ state }) : null;
        let persisted = false;
        try {
            if (result.status !== 'committed') this.diagnostics.warn('SHADOW_CANDIDATE', `Shadow candidate was not comparable: ${result.status}`, { errors: result.errors ?? [], parity });
            sidecar.canonical.persisted = true;
            if (typeof this.store.saveShadowCommit === 'function') await this.store.saveShadowCommit(authoritative, sidecar, { expectedChatId: targetChatId });
            else {
                await this.store.save(authoritative, { expectedChatId: targetChatId });
                await this.store.saveShadowReport?.(sidecar, { expectedChatId: targetChatId });
            }
            persisted = true;
            const comparable = parity.status !== 'not_comparable';
            this.diagnostics[parity.equal ? 'info' : 'warn']('SHADOW_PARITY', parity.equal
                ? 'Shadow candidate matches authoritative legacy actor/scene/ct paths.'
                : comparable ? 'Shadow candidate diverges from authoritative legacy actor/scene/ct paths.' : `Authoritative legacy state advanced; candidate was ${result.status}.`, { parity: sidecar });
        } catch (error) {
            sidecar.canonical.persisted = false;
            if (error instanceof ChatSwitchError) this.diagnostics.warn('CHAT_SWITCH', error.message);
            else this.diagnostics.error('PERSISTENCE', `Could not persist authoritative shadow import: ${error.message}`);
            const failure = { status: 'persistence_error', mode: 'SHADOW', state, displayText: extracted.prose, extracted, error, parity: sidecar, persisted: false };
            recordControlMetadata(message, extracted, failure, this.now());
            stripMessageControlPayload(message);
            try { await this.adapter.saveChat?.({ expectedChatId: targetChatId }); } catch { /* preserve original diagnostic */ }
            return failure;
        }

        const shadowResult = {
            status: parity.equal ? 'shadow_match' : parity.status === 'not_comparable' ? 'shadow_not_comparable' : 'shadow_diverged',
            mode: 'SHADOW',
            state: authoritative,
            candidateStatus: result.status,
            candidate: result.status === 'committed' ? { ct: result.state.ct, head: result.state.head } : null,
            parity: sidecar,
            transactionId: result.transactionId,
            extracted,
            displayText: extracted.prose,
            persisted,
        };
        recordControlMetadata(message, extracted, shadowResult, this.now());
        stripMessageControlPayload(message);
        try { await this.adapter.saveChat?.({ expectedChatId: targetChatId }); } catch (error) { this.diagnostics.warn('MESSAGE_SAVE', `Control payload removed for display but chat save failed: ${error.message}`); }
        return shadowResult;
    }

    diagnosticsSnapshot() {
        return {
            ...this.adapter.diagnostics(),
            mode: this.getMode(),
            modes: [...ENGINE_MODES],
            defaultMode: getGlobalDefaultMode(this.adapter.getSettings?.()),
            events: this.diagnostics.list(),
        };
    }
}

export function createEngine(options = {}) {
    return new STStateEngine(options);
}

