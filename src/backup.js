import { migrateState, EXTENSION_KEY } from './schema.js';
import { makeDiff } from './reducer.js';
import { deepClone, stableHash } from './util.js';

export function createJsonBackup(state, { chatId = '', exportedAt = Date.now() } = {}) {
    return {
        extension: EXTENSION_KEY,
        backupVersion: 1,
        exportedAt,
        ...(chatId ? { chatId: String(chatId) } : {}),
        state: migrateState(state, { now: exportedAt }),
    };
}

export function stringifyBackup(state, options = {}) {
    return JSON.stringify(createJsonBackup(state, options), null, 2);
}

export function parseJsonBackup(input, { now = Date.now() } = {}) {
    const value = typeof input === 'string' ? JSON.parse(input) : input;
    if (!value || typeof value !== 'object') throw new Error('FF5 backup must be a JSON object');
    const rawState = value.state ?? value.ff5Engine ?? value;
    if (!rawState || typeof rawState !== 'object') throw new Error('FF5 backup has no state object');
    return {
        extension: value.extension ?? EXTENSION_KEY,
        backupVersion: value.backupVersion ?? 0,
        exportedAt: value.exportedAt ?? null,
        chatId: value.chatId ?? '',
        state: migrateState(rawState, { now }),
    };
}

export function previewJsonRestore(currentState, input, options = {}) {
    const imported = parseJsonBackup(input, options);
    const current = migrateState(currentState, options);
    return {
        ...imported,
        current,
        imported: imported.state,
        changed: stableHash(current) !== stableHash(imported.state),
        diff: makeDiff(current, imported.state),
    };
}

export function cloneBackup(input, options = {}) {
    return deepClone(parseJsonBackup(input, options));
}


