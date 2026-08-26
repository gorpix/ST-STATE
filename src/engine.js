import { ChatSwitchError } from './store.js';
import { applyTransaction } from './reducer.js';
import { buildProtocolPrompt } from './selector.js';
import { extractHiddenPatch, messageText, stripMessageControlPayload } from './patch.js';
import { transactionIdentity } from './identity.js';
import { DiagnosticLog } from './diagnostics.js';
import { deepClone, sanitizePlainText } from './util.js';

export const SKIP_GENERATION_TYPES = new Set(['quiet', 'impersonate', 'continue']);

function recordControlMetadata(message, extracted, result, at) {
    if (!message || typeof message !== 'object') return;
    if (!message.extra || typeof message.extra !== 'object' || Array.isArray(message.extra)) message.extra = {};
    const record = {
        version: 1,
        at,
        status: result?.status ?? 'unknown',
        flashHandoff: extracted?.flashHandoff === true,
    };
    if (extracted?.patch) record.patch = deepClone(extracted.patch);
    if (extracted?.error) record.error = sanitizePlainText(extracted.error, { maxLength: 1000, preserveNewlines: false });
    if (result?.transactionId) record.transactionId = sanitizePlainText(result.transactionId, { maxLength: 200, preserveNewlines: false });
    if (Array.isArray(result?.errors) && result.errors.length) record.errors = result.errors.map((error) => sanitizePlainText(error, { maxLength: 1000, preserveNewlines: false }));
    message.extra.ff5Engine = record;
}

export class FF5Engine {
    constructor({ adapter, store, diagnostics = new DiagnosticLog(), now = () => Date.now() } = {}) {
        this.adapter = adapter;
        this.store = store;
        this.diagnostics = diagnostics;
        this.now = now;
        this.processing = Promise.resolve();
    }

    loadState() {
        return this.store.load();
    }

    buildPrompt(options = {}) {
        const state = this.loadState();
        const userText = options.userText ?? this.latestUserText();
        return buildProtocolPrompt(state, { ...options, userText });
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
        if (SKIP_GENERATION_TYPES.has(generationType)) {
            this.adapter.clearPrompt();
            return { injected: false, skipped: true, type: generationType };
        }
        try {
            const prompt = this.buildPrompt(options);
            this.adapter.setPrompt(prompt.text);
            this.diagnostics.info('PROMPT_INJECTED', `Hot state pack injected for ${generationType}`, { selected: prompt.selection.selectedActorIds });
            return { injected: true, skipped: false, type: generationType, selection: prompt.selection, text: prompt.text };
        } catch (error) {
            this.diagnostics.warn('PROMPT_UNAVAILABLE', `Prompt injection unavailable: ${error.message}`);
            return { injected: false, skipped: false, error };
        }
    }

    processAssistantMessage(message, { index = -1, messageIdentity = '', expectedChatId = undefined } = {}) {
        // Queue commits so two event hooks cannot both pass the same base/head
        // check before either one persists.
        const task = this.processing.then(() => this._processAssistantMessage(message, { index, messageIdentity, expectedChatId }));
        this.processing = task.catch(() => undefined);
        return task;
    }

    async _processAssistantMessage(message, { index = -1, messageIdentity = '', expectedChatId = undefined } = {}) {
        const raw = messageText(message);
        const extracted = extractHiddenPatch(raw);
        if (!extracted.found && !extracted.flashHandoff) {
            this.diagnostics.warn('PATCH_MISSING', 'No FF5_PATCH was found; canonical state was kept unchanged. Retry the turn or use a manual import.', { messageIndex: index });
            return { status: 'missing', state: this.loadState(), displayText: raw, extracted };
        }
        const state = this.loadState();
        const identity = messageIdentity || `message:${index}`;
        const result = applyTransaction(state, extracted.patch, {
            messageIdentity: identity,
            flashHandoff: extracted.flashHandoff,
            now: this.now(),
        });
        let persisted = false;
        if (result.status === 'committed') {
            try {
                await this.store.save(result.state, { expectedChatId: expectedChatId === undefined ? this.adapter.getChatId?.() : expectedChatId });
                persisted = true;
                this.diagnostics.info('COMMIT', `Committed NORMAL turn ${result.state.ct}`, { transactionId: result.transactionId, summary: result.historyEntry.summary });
            } catch (error) {
                if (error instanceof ChatSwitchError) this.diagnostics.warn('CHAT_SWITCH', error.message);
                else this.diagnostics.error('PERSISTENCE', `Could not persist NORMAL turn: ${error.message}`);
                recordControlMetadata(message, extracted, { ...result, status: 'persistence_error', errors: [error.message] }, this.now());
                stripMessageControlPayload(message);
                try { await this.adapter.saveChat?.(); } catch { /* preserve the original persistence diagnostic */ }
                return { status: 'persistence_error', state, displayText: extracted.prose, extracted, error, persisted: false };
            }
        } else if (result.status === 'rejected') {
            this.diagnostics.warn('PATCH_REJECTED', `FF5 patch rejected: ${(result.errors ?? []).join('; ')}`, { errors: result.errors });
        } else if (result.status === 'stale') {
            this.diagnostics.warn('PATCH_STALE', `FF5 patch base ${result.received} does not match current head ${result.expected}; retry or manually import the state.`, { expected: result.expected, received: result.received });
        } else if (result.status === 'duplicate') {
            this.diagnostics.info('PATCH_DUPLICATE', 'Duplicate FF5 transaction ignored', { transactionId: result.transactionId });
        } else if (result.status === 'ignored') {
            this.diagnostics.info('PATCH_IGNORED', `FF5 ${result.reason} response did not mutate state`);
        }

        // Control comments are removed from the message only after a successful
        // metadata write, or after a deliberate reject/ignore decision.
        const displayText = extracted.prose;
        if (extracted.found || extracted.flashHandoff) recordControlMetadata(message, extracted, result, this.now());
        if (extracted.found || extracted.flashHandoff) stripMessageControlPayload(message);
        if (extracted.found || extracted.flashHandoff) {
            try { await this.adapter.saveChat?.(); } catch (error) { this.diagnostics.warn('MESSAGE_SAVE', `Control payload removed for display but chat save failed: ${error.message}`); }
        }
        return { ...result, displayText, extracted, persisted };
    }

    diagnosticsSnapshot() {
        return { ...this.adapter.diagnostics(), events: this.diagnostics.list() };
    }
}

export function createEngine(options = {}) {
    return new FF5Engine(options);
}

