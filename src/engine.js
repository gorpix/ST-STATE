import { ChatSwitchError } from './store.js';
import { applyTransaction, makeDiff, summarizeDiff } from './reducer.js';
import { buildProtocolPrompt } from './selector.js';
import { extractHiddenPatch, messageText, stripMessageControlPayload } from './patch.js';
import { makeStableActorId, transactionIdentity } from './identity.js';
import { extractLatestInternalStates, importLegacyState, stripMessageInternalStatesPayload } from './legacy.js';
import { DiagnosticLog } from './diagnostics.js';
import { CHAT_CONFIG_KEY, DEFAULT_ENGINE_MODE, ENGINE_MODES, getChatMode, getGlobalDefaultMode, normalizeEngineMode } from './modes.js';
import { compareShadowParity, makeShadowSidecar } from './shadow.js';
import { deepClone, sanitizePlainText } from './util.js';

export const SKIP_GENERATION_TYPES = new Set(['quiet', 'impersonate', 'continue']);

export function recordControlMetadata(message, extracted, result, at, { swipeIdentity = '' } = {}) {
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
    if (swipeIdentity) {
        if (!message.extra.stStateSwipes || typeof message.extra.stStateSwipes !== 'object' || Array.isArray(message.extra.stStateSwipes)) message.extra.stStateSwipes = {};
        message.extra.stStateSwipes[swipeIdentity] = deepClone(record);
        const keys = Object.keys(message.extra.stStateSwipes);
        for (const key of keys.slice(0, Math.max(0, keys.length - 20))) delete message.extra.stStateSwipes[key];
    }
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
    return normalizeEngineMode(requested);
}

function bootstrapNativeActors(state, { userName = '', npcNames = [] } = {}) {
    const source = deepClone(state);
    if (source.ct !== 0 || source.head !== 'GENESIS') return { changed: false, state: source, actorIds: [] };
    const actorIds = [];
    const cleanUserName = sanitizePlainText(userName, { maxLength: 200, preserveNewlines: false });
    if (!source.actors.US) {
        source.actors.US = { id: 'US', name: cleanUserName || '{{user}}' };
        actorIds.push('US');
    }
    const seenNames = new Set(Object.values(source.actors).map((actor) => String(actor?.name ?? '').trim().toLowerCase()).filter(Boolean));
    for (const rawName of Array.isArray(npcNames) ? npcNames : [npcNames]) {
        const name = sanitizePlainText(rawName, { maxLength: 200, preserveNewlines: false });
        if (!name || name.toLowerCase() === cleanUserName.toLowerCase() || seenNames.has(name.toLowerCase())) continue;
        const id = makeStableActorId(name, source.actors);
        source.actors[id] = { id, name };
        seenNames.add(name.toLowerCase());
        actorIds.push(id);
        if (actorIds.length >= 13) break;
    }
    return { changed: actorIds.length > 0, state: source, actorIds };
}

const NATIVE_COMPATIBILITY_ROOTS = Object.freeze([
    ['FACTIONS', 'factions'],
    ['EMOTIONAL RESIDUE', 'residue'],
    ['QUESTS', 'quests'],
    ['INV & SKILLS', 'inventory'],
    ["CHEKHOV'S GUN", 'chekhov'],
    ['INTERNAL THOUGHTS', 'thoughts'],
    ["GM'S NOTEBOOK", 'notebook'],
    ['DND TASK SIM', 'lastDnd'],
]);

function stageNativeCompatibility(raw, state, { now, userName } = {}) {
    const block = extractLatestInternalStates(raw);
    if (!block.ok) return { ok: true, found: false, state: deepClone(state), missingSections: [] };
    const imported = importLegacyState(raw, {
        now,
        baseState: state,
        preserveMissingFromBase: true,
        mergeSparseFromBase: true,
        requireTurn: true,
        userName,
    });
    if (!imported.ok) return { ok: false, found: true, state: deepClone(state), errors: imported.diagnostics ?? ['Invalid Native compatibility fragment'] };
    if (imported.state.ct !== state.ct + 1) {
        return { ok: false, found: true, state: deepClone(state), errors: [`Compatibility turn ${imported.state.ct} did not follow canonical turn ${state.ct}`] };
    }
    const staged = deepClone(state);
    const missing = new Set(imported.missingSections ?? []);
    for (const [section, root] of NATIVE_COMPATIBILITY_ROOTS) {
        if (!missing.has(section)) staged[root] = deepClone(imported.state[root]);
    }
    if (!missing.has('BONDS')) staged.relations.profiles = deepClone(imported.state.relations?.profiles ?? {});
    if (/WORLD\s+SIM/i.test(block.raw)) staged.worldSim = deepClone(imported.state.worldSim);
    staged.opaque = deepClone(imported.state.opaque ?? staged.opaque);
    // Compatibility data is staged against the current transaction base. The
    // authoritative Native patch below owns ct/head/history exactly once.
    staged.ct = state.ct;
    staged.head = state.head;
    staged.meta = deepClone(state.meta);
    staged.history = deepClone(state.history ?? []);
    staged.dedupe = deepClone(state.dedupe ?? []);
    return { ok: true, found: true, state: staged, missingSections: imported.missingSections ?? [] };
}

function includeCompatibilityInCommit(result, before) {
    if (result.status !== 'committed') return result;
    const diff = makeDiff(before, result.state);
    const history = [...(result.state.history ?? [])];
    const entry = history.at(-1);
    if (entry) {
        entry.diff = deepClone(diff);
        entry.summary = summarizeDiff(diff);
        result.historyEntry = deepClone(entry);
    }
    result.state.history = history;
    result.diff = diff;
    return result;
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
        preserveMissingFromBase: true,
        mergeSparseFromBase: true,
        requireTurn: true,
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
        let state = this.loadState({ initialize: false });
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
        if (mode !== 'SHADOW' && mode !== 'NATIVE') {
            this.adapter.clearPrompt();
            const reason = mode === 'LEGACY' ? 'legacy_mode' : 'recovery_mode';
            this.diagnostics.info('MODE_NO_INJECT', `Prompt injection disabled in ${mode} mode`);
            return { injected: false, skipped: true, type: generationType, mode, reason };
        }
        let state = this.loadState({ initialize: false });
        if (mode === 'SHADOW') {
            const baseline = options.verifiedBranchBaseline === true
                ? { status: 'verified_branch', ready: true }
                : inspectShadowBaseline(this.adapter, state, { now: this.now() });
            if (baseline.status === 'missing' || baseline.status === 'incomplete') {
                this.adapter.clearPrompt();
                this.diagnostics.warn('BASELINE_REQUIRED', 'Import the latest usable legacy state before Shadow prompt injection.');
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
        }
        try {
            let promptOptions = { ...options, mode };
            if (mode === 'NATIVE') {
                const bootstrap = bootstrapNativeActors(state, {
                    userName: this.adapter?.getUserName?.(),
                    npcNames: options.bootstrapNpcNames,
                });
                if (bootstrap.changed) {
                    state = await this.store.save(bootstrap.state, { expectedChatId: this.adapter?.getChatId?.() });
                    promptOptions = {
                        ...promptOptions,
                        mentionedActorIds: [...new Set([...(options.mentionedActorIds ?? []), ...bootstrap.actorIds])],
                    };
                    this.diagnostics.info('NATIVE_BOOTSTRAP', 'Hybrid Native initialized first-turn actor identities.', { actorIds: bootstrap.actorIds });
                }
            }
            const prompt = this.buildPrompt(promptOptions);
            this.adapter.setPrompt(prompt.text);
            this.diagnostics.info('PROMPT_INJECTED', `${mode === 'NATIVE' ? 'Hybrid Native' : 'Shadow'} protocol injected for ${generationType}`, { selected: prompt.selection.selectedActorIds, mode });
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
        if (activeMode === 'NATIVE') return this._processNativeMessage(message, { index, messageIdentity, expectedChatId, raw });
        return this._processShadowMessage(message, { index, messageIdentity, expectedChatId, raw });
    }

    async _processNativeMessage(message, { index = -1, messageIdentity = '', expectedChatId = undefined, raw }) {
        const extracted = extractHiddenPatch(raw);
        const state = this.loadState();
        const identity = messageIdentity || `message:${index}`;
        const targetChatId = expectedChatId === undefined ? this.adapter.getChatId?.() : expectedChatId;
        const cleanup = async (result) => {
            recordControlMetadata(message, extracted, result, this.now(), { swipeIdentity: identity });
            stripMessageControlPayload(message);
            stripMessageInternalStatesPayload(message);
            try { await this.adapter.saveChat?.({ expectedChatId: targetChatId }); }
            catch (error) { this.diagnostics.warn('MESSAGE_SAVE', `Native control cleanup could not be persisted: ${error.message}`); }
        };

        if (extracted.flashHandoff) {
            const result = { status: 'ignored', reason: 'flash_handoff', mode: 'NATIVE', state, displayText: extracted.prose, extracted, persisted: false };
            await cleanup(result);
            return result;
        }
        if (!extracted.found || !extracted.ok) {
            const status = extracted.found ? 'native_malformed' : 'native_missing';
            const errors = [extracted.error || 'No usable ST_PATCH comment was found'];
            const result = { status, mode: 'NATIVE', state, displayText: extracted.prose, extracted, errors, persisted: false };
            this.diagnostics.warn('NATIVE_PATCH', `Hybrid Native turn was not committed: ${errors[0]}`, { messageIndex: index });
            if (extracted.controlBearing || extractLatestInternalStates(raw).ok) await cleanup(result);
            return result;
        }

        if (['OOC', 'FLASH'].includes(String(extracted.patch.mode).toUpperCase())) {
            const frozen = applyTransaction(state, extracted.patch, { messageIdentity: identity, flashHandoff: false, now: this.now() });
            const result = { ...frozen, status: 'ignored', reason: frozen.reason, mode: 'NATIVE', state, displayText: extracted.prose, extracted, persisted: false };
            await cleanup(result);
            return result;
        }

        const compatibility = stageNativeCompatibility(raw, state, { now: this.now(), userName: this.adapter?.getUserName?.() });
        if (!compatibility.ok) {
            const result = { status: 'native_compatibility_rejected', mode: 'NATIVE', state, displayText: extracted.prose, extracted, errors: compatibility.errors, persisted: false };
            this.diagnostics.warn('NATIVE_COMPATIBILITY', `Hybrid Native compatibility state was rejected: ${(compatibility.errors ?? []).join('; ')}`, { messageIndex: index });
            await cleanup(result);
            return result;
        }

        let applied = applyTransaction(compatibility.state, extracted.patch, { messageIdentity: identity, flashHandoff: false, now: this.now() });
        applied = includeCompatibilityInCommit(applied, state);
        if (applied.status !== 'committed') {
            const result = { ...applied, status: `native_${applied.status}`, mode: 'NATIVE', state, displayText: extracted.prose, extracted, persisted: false, compatibility: compatibility.found };
            this.diagnostics.warn('NATIVE_PATCH', `Hybrid Native patch was not committed: ${applied.status}`, { errors: applied.errors ?? [], messageIndex: index });
            await cleanup(result);
            return result;
        }

        try {
            await this.store.save(applied.state, { expectedChatId: targetChatId });
        } catch (error) {
            if (error instanceof ChatSwitchError) this.diagnostics.warn('CHAT_SWITCH', error.message);
            else this.diagnostics.error('PERSISTENCE', `Could not persist Hybrid Native state: ${error.message}`);
            const failure = { status: 'persistence_error', mode: 'NATIVE', state, displayText: extracted.prose, extracted, error, persisted: false };
            await cleanup(failure);
            return failure;
        }

        const result = {
            ...applied,
            status: 'native_committed',
            mode: 'NATIVE',
            displayText: extracted.prose,
            extracted,
            compatibility: compatibility.found,
            persisted: true,
        };
        this.diagnostics.info('NATIVE_COMMIT', `Hybrid Native committed ct ${result.state.ct}.`, { paths: result.diff?.forward?.map((change) => change.path) ?? [] });
        await cleanup(result);
        return result;
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
                recordControlMetadata(message, extracted, result, this.now(), { swipeIdentity: identity });
                stripMessageControlPayload(message);
                try { await this.adapter.saveChat?.({ expectedChatId: targetChatId }); } catch { /* display cleanup is best effort */ }
            }
            return { ...result, displayText: extracted.prose, extracted };
        }

        const importedResult = importLegacyState(raw, { now: this.now(), baseState: state, preserveMissingFromBase: true, mergeSparseFromBase: true, requireTurn: true, userName: this.adapter?.getUserName?.() });
        if (!importedResult.ok) {
            this.diagnostics.warn('SHADOW_LEGACY_MISSING', 'Shadow mode requires a usable <internal_states> block with a turn header; canonical state was kept unchanged.', { messageIndex: index });
            const result = { status: 'missing_legacy', mode: 'SHADOW', state, displayText: extracted.found ? extracted.prose : raw, extracted, persisted: false };
            recordControlMetadata(message, extracted, result, this.now(), { swipeIdentity: identity });
            if (extracted.controlBearing) {
                stripMessageControlPayload(message);
                try { await this.adapter.saveChat?.({ expectedChatId: targetChatId }); } catch { /* rejection cleanup is best effort */ }
            }
            return result;
        }

        const authoritative = preserveCanonicalBookkeeping(importedResult.state, state);
        if (!importedResult.complete) this.diagnostics.info('SHADOW_LEGACY_PARTIAL', `Accepted partial legacy turn and preserved ${importedResult.missingSections.length} missing sections.`, { messageIndex: index, missingSections: importedResult.missingSections });
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
            recordControlMetadata(message, extracted, mismatch, this.now(), { swipeIdentity: identity });
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
        sidecar.legacy = {
            status: hasBaseline ? (importedResult.complete ? 'accepted' : 'partial_accepted') : 'baseline',
            ct: authoritative.ct,
            head: authoritative.head,
            complete: importedResult.complete,
            missingSections: deepClone(importedResult.missingSections ?? []),
        };
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
            recordControlMetadata(message, extracted, failure, this.now(), { swipeIdentity: identity });
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
        recordControlMetadata(message, extracted, shadowResult, this.now(), { swipeIdentity: identity });
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

