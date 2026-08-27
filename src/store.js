import { createEmptyState, EXTENSION_KEY, migrateState } from './schema.js';
import { makeDiff } from './reducer.js';
import { SHADOW_SIDECAR_KEY } from './modes.js';
import { assertBranchLedgerSize, BRANCH_SIDECAR_KEY, createBranchLedger, normalizeBranchLedger } from './branch.js';
import { deepClone, stableHash, stableStringify } from './util.js';

export class ChatSwitchError extends Error {
    constructor(message = 'The active chat changed while ST-STATE was writing state') {
        super(message);
        this.name = 'ChatSwitchError';
    }
}

function currentChatId(host) {
    const value = host?.getChatId?.();
    return value === undefined || value === null ? '' : String(value);
}

const MAX_SHADOW_REPORTS = 25;
const MAX_SHADOW_IDENTITIES = 100;

function compactShadowReport(report) {
    if (!report || typeof report !== 'object') return null;
    const compact = {};
    for (const key of ['version', 'status', 'mode', 'at', 'transactionId', 'messageId', 'candidateStatus', 'previous', 'legacy', 'patch', 'canonical']) {
        if (report[key] !== undefined) compact[key] = deepClone(report[key]);
    }
    return compact;
}

function nextShadowSidecar(previous, report) {
    const priorReports = Array.isArray(previous?.reports)
        ? previous.reports.map(compactShadowReport).filter(Boolean)
        : (previous ? [compactShadowReport(previous)].filter(Boolean) : []);
    const latest = compactShadowReport(report);
    const reports = [...priorReports, latest].filter(Boolean).slice(-MAX_SHADOW_REPORTS);
    const identities = [
        ...(Array.isArray(previous?.seen) ? previous.seen : []),
        report?.messageId ? `message:${report.messageId}` : '',
        report?.transactionId ? `tx:${report.transactionId}` : '',
    ].filter(Boolean);
    return {
        ...deepClone(report),
        reports,
        seen: [...new Set(identities)].slice(-MAX_SHADOW_IDENTITIES),
    };
}

export class ChatStore {
    constructor(host, { key = EXTENSION_KEY, now = () => Date.now() } = {}) {
        this.host = host;
        this.key = key;
        this.now = now;
    }

    metadata() {
        // Deliberately fetch this every time. ST replaces the reference on
        // CHAT_CHANGED and retaining it would write state into the prior chat.
        const metadata = this.host?.getMetadata?.();
        if (!metadata || typeof metadata !== 'object') throw new Error('Current chat metadata is unavailable');
        return metadata;
    }

    load({ initialize = true } = {}) {
        const metadata = this.metadata();
        const raw = metadata[this.key];
        const state = raw ? migrateState(raw, { now: this.now() }) : createEmptyState({ now: this.now() });
        if (initialize && (!raw || stableStringify(raw) !== stableStringify(state))) metadata[this.key] = deepClone(state);
        return deepClone(state);
    }

    getState(options = {}) {
        return this.load(options);
    }

    async save(state, { expectedChatId = undefined } = {}) {
        const beforeId = expectedChatId === undefined ? currentChatId(this.host) : String(expectedChatId);
        const enforceChatIdentity = expectedChatId !== undefined || beforeId !== '';
        const metadata = this.metadata();
        if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
        const previous = hasMetadata(metadata, this.key) ? deepClone(metadata[this.key]) : undefined;
        const normalized = migrateState(state, { now: this.now() });
        metadata[this.key] = deepClone(normalized);
        try {
            if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
            await this.host.saveMetadata();
            if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
            return deepClone(normalized);
        } catch (error) {
            // Roll back the same fresh metadata object. If ST switched chats,
            // the old reference is not touched by this branch.
            if (previous === undefined) delete metadata[this.key];
            else metadata[this.key] = previous;
            throw error;
        }
    }

    getShadowReport() {
        const metadata = this.metadata();
        return metadata[SHADOW_SIDECAR_KEY] ? deepClone(metadata[SHADOW_SIDECAR_KEY]) : null;
    }

    loadBranchLedger({ initialize = true } = {}) {
        const metadata = this.metadata();
        const raw = metadata[BRANCH_SIDECAR_KEY];
        const ledger = raw ? normalizeBranchLedger(raw) : createBranchLedger();
        if (initialize && (!raw || stableStringify(raw) !== stableStringify(ledger))) metadata[BRANCH_SIDECAR_KEY] = deepClone(ledger);
        return deepClone(ledger);
    }

    async saveBranchLedger(ledger, { expectedChatId = undefined } = {}) {
        const beforeId = expectedChatId === undefined ? currentChatId(this.host) : String(expectedChatId);
        const enforceChatIdentity = expectedChatId !== undefined || beforeId !== '';
        const metadata = this.metadata();
        if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
        const previous = hasMetadata(metadata, BRANCH_SIDECAR_KEY) ? deepClone(metadata[BRANCH_SIDECAR_KEY]) : undefined;
        const normalized = normalizeBranchLedger(ledger);
        assertBranchLedgerSize(normalized);
        metadata[BRANCH_SIDECAR_KEY] = deepClone(normalized);
        try {
            if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
            await this.host.saveMetadata();
            if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
            return deepClone(normalized);
        } catch (error) {
            if (previous === undefined) delete metadata[BRANCH_SIDECAR_KEY];
            else metadata[BRANCH_SIDECAR_KEY] = previous;
            throw error;
        }
    }

    /** Persist a branch rollback/rebaseline atomically with canonical state. */
    async saveBranchCommit(state, ledger, report = undefined, { expectedChatId = undefined } = {}) {
        const beforeId = expectedChatId === undefined ? currentChatId(this.host) : String(expectedChatId);
        const enforceChatIdentity = expectedChatId !== undefined || beforeId !== '';
        const metadata = this.metadata();
        if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
        const previousState = hasMetadata(metadata, this.key) ? deepClone(metadata[this.key]) : undefined;
        const previousBranches = hasMetadata(metadata, BRANCH_SIDECAR_KEY) ? deepClone(metadata[BRANCH_SIDECAR_KEY]) : undefined;
        const previousReport = hasMetadata(metadata, SHADOW_SIDECAR_KEY) ? deepClone(metadata[SHADOW_SIDECAR_KEY]) : undefined;
        const normalizedState = migrateState(state, { now: this.now() });
        const normalizedBranches = normalizeBranchLedger(ledger);
        assertBranchLedgerSize(normalizedBranches);
        metadata[this.key] = deepClone(normalizedState);
        metadata[BRANCH_SIDECAR_KEY] = deepClone(normalizedBranches);
        if (report !== undefined) metadata[SHADOW_SIDECAR_KEY] = nextShadowSidecar(previousReport, report);
        try {
            if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
            await this.host.saveMetadata();
            if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
            return {
                state: deepClone(normalizedState),
                branches: deepClone(normalizedBranches),
                report: report === undefined ? deepClone(previousReport ?? null) : deepClone(metadata[SHADOW_SIDECAR_KEY]),
            };
        } catch (error) {
            if (previousState === undefined) delete metadata[this.key];
            else metadata[this.key] = previousState;
            if (previousBranches === undefined) delete metadata[BRANCH_SIDECAR_KEY];
            else metadata[BRANCH_SIDECAR_KEY] = previousBranches;
            if (previousReport === undefined) delete metadata[SHADOW_SIDECAR_KEY];
            else metadata[SHADOW_SIDECAR_KEY] = previousReport;
            throw error;
        }
    }

    async saveShadowReport(report, { expectedChatId = undefined } = {}) {
        const beforeId = expectedChatId === undefined ? currentChatId(this.host) : String(expectedChatId);
        const enforceChatIdentity = expectedChatId !== undefined || beforeId !== '';
        const metadata = this.metadata();
        if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
        const previous = hasMetadata(metadata, SHADOW_SIDECAR_KEY) ? deepClone(metadata[SHADOW_SIDECAR_KEY]) : undefined;
        const stored = nextShadowSidecar(previous, report);
        metadata[SHADOW_SIDECAR_KEY] = stored;
        try {
            if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
            await this.host.saveMetadata();
            if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
            return deepClone(stored);
        } catch (error) {
            if (previous === undefined) delete metadata[SHADOW_SIDECAR_KEY];
            else metadata[SHADOW_SIDECAR_KEY] = previous;
            throw error;
        }
    }

    /** Persist the authoritative legacy import and its evaluator report together. */
    async saveShadowCommit(state, report, { expectedChatId = undefined } = {}) {
        const beforeId = expectedChatId === undefined ? currentChatId(this.host) : String(expectedChatId);
        const enforceChatIdentity = expectedChatId !== undefined || beforeId !== '';
        const metadata = this.metadata();
        if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
        const previousState = hasMetadata(metadata, this.key) ? deepClone(metadata[this.key]) : undefined;
        const previousReport = hasMetadata(metadata, SHADOW_SIDECAR_KEY) ? deepClone(metadata[SHADOW_SIDECAR_KEY]) : undefined;
        const normalized = migrateState(state, { now: this.now() });
        metadata[this.key] = deepClone(normalized);
        const storedReport = nextShadowSidecar(previousReport, report);
        metadata[SHADOW_SIDECAR_KEY] = storedReport;
        try {
            if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
            await this.host.saveMetadata();
            if (enforceChatIdentity && currentChatId(this.host) !== beforeId) throw new ChatSwitchError();
            return { state: deepClone(normalized), report: deepClone(storedReport) };
        } catch (error) {
            if (previousState === undefined) delete metadata[this.key];
            else metadata[this.key] = previousState;
            if (previousReport === undefined) delete metadata[SHADOW_SIDECAR_KEY];
            else metadata[SHADOW_SIDECAR_KEY] = previousReport;
            throw error;
        }
    }

    clearShadowReport() {
        const metadata = this.metadata();
        delete metadata[SHADOW_SIDECAR_KEY];
    }

    recoveryBackup(options = {}) {
        return this.backup(options);
    }

    backup({ state = undefined, includeChatId = true } = {}) {
        const document = {
            extension: EXTENSION_KEY,
            backupVersion: 1,
            exportedAt: this.now(),
            chatId: includeChatId ? currentChatId(this.host) : undefined,
            state: deepClone(state ?? this.load()),
        };
        if (!includeChatId) delete document.chatId;
        return JSON.stringify(document, null, 2);
    }

    parseBackup(input) {
        let value = input;
        if (typeof value === 'string') {
            try { value = JSON.parse(value); } catch (error) { throw new Error(`Invalid ST-STATE backup JSON: ${error.message}`); }
        }
        if (!value || typeof value !== 'object') throw new Error('ST-STATE backup must be a JSON object');
        const rawState = value.state ?? value.stState ?? value;
        if (!rawState || typeof rawState !== 'object') throw new Error('ST-STATE backup has no state object');
        return { extension: value.extension ?? EXTENSION_KEY, backupVersion: value.backupVersion ?? 0, chatId: value.chatId ?? '', state: migrateState(rawState, { now: this.now() }) };
    }

    previewRestore(input, options = {}) {
        const backup = this.parseBackup(input);
        const current = this.load();
        const imported = backup.state;
        const currentDigest = stableHash(current);
        const importedDigest = stableHash(imported);
        const diff = options.diff ?? makeDiff(current, imported);
        return { ...backup, current, imported, changed: currentDigest !== importedDigest, currentDigest, importedDigest, diff };
    }

    async restore(input, { expectedChatId = undefined } = {}) {
        const backup = this.parseBackup(input);
        return this.save(backup.state, { expectedChatId });
    }
}

function hasMetadata(metadata, key) {
    return Object.prototype.hasOwnProperty.call(metadata, key);
}

export function createChatStore(host, options = {}) {
    return new ChatStore(host, options);
}

