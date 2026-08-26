import { createEmptyState, EXTENSION_KEY, migrateState } from './schema.js';
import { makeDiff } from './reducer.js';
import { deepClone, stableHash, stableStringify } from './util.js';

export class ChatSwitchError extends Error {
    constructor(message = 'The active chat changed while FF5 was writing state') {
        super(message);
        this.name = 'ChatSwitchError';
    }
}

function currentChatId(host) {
    const value = host?.getChatId?.();
    return value === undefined || value === null ? '' : String(value);
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
            try { value = JSON.parse(value); } catch (error) { throw new Error(`Invalid FF5 backup JSON: ${error.message}`); }
        }
        if (!value || typeof value !== 'object') throw new Error('FF5 backup must be a JSON object');
        const rawState = value.state ?? value.ff5Engine ?? value;
        if (!rawState || typeof rawState !== 'object') throw new Error('FF5 backup has no state object');
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

