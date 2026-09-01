import { deepClone, deepEqual, hasOwn, isPlainObject, stableHash, stableStringify } from './util.js';
import { migrateState, MAX_HISTORY, relationKey } from './schema.js';
import { transactionIdentity } from './identity.js';
import { MAX_RESIDUE_ENTRIES, residueEntries } from './residue.js';
import { validatePatchEnvelope } from './validation.js';

function setAtPath(target, path, value) {
    const parts = path.split('.');
    let cursor = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
        if (!isPlainObject(cursor[parts[index]])) cursor[parts[index]] = {};
        cursor = cursor[parts[index]];
    }
    cursor[parts[parts.length - 1]] = deepClone(value);
}

function valuesAtPath(target, path) {
    const parts = path.split('.');
    let cursor = target;
    for (const part of parts) {
        if (cursor === null || cursor === undefined) return undefined;
        cursor = cursor[part];
    }
    return cursor;
}

/** Return leaf-level changes plus a corresponding inverse list. */
export function diffValues(before, after, path = '', output = []) {
    if (deepEqual(before, after)) return output;
    if (isPlainObject(before) && isPlainObject(after)) {
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        for (const key of [...keys].sort()) {
            const childPath = path ? `${path}.${key}` : key;
            diffValues(before[key], after[key], childPath, output);
        }
        return output;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
        output.push({ path, before: deepClone(before), after: deepClone(after) });
        return output;
    }
    output.push({ path, before: deepClone(before), after: deepClone(after) });
    return output;
}

export function makeDiff(before, after) {
    const forward = diffValues(before, after);
    const inverse = forward.map((change) => ({
        path: change.path,
        before: deepClone(change.after),
        after: deepClone(change.before),
    }));
    return { forward, inverse };
}

export function applyDiff(state, changes) {
    const result = deepClone(state);
    for (const change of changes ?? []) {
        if (!change || typeof change.path !== 'string' || !change.path || change.path.split('.').some((part) => !part || part === '__proto__' || part === 'constructor' || part === 'prototype')) continue;
        if (change.after === undefined) {
            const parts = change.path.split('.');
            const parent = valuesAtPath(result, parts.slice(0, -1).join('.'));
            if (isPlainObject(parent)) delete parent[parts.at(-1)];
        } else setAtPath(result, change.path, change.after);
    }
    return result;
}

function applyOperations(state, operations) {
    const result = deepClone(state);
    const setActorThoughts = (id, value) => {
        const actor = result.actors[id] ?? {};
        const aliases = new Set([id, actor.name, actor.displayName].filter(Boolean).map((item) => String(item).trim().toLowerCase()));
        result.thoughts = (result.thoughts ?? []).filter((item) => {
            const owner = typeof item === 'string' ? '' : String(item?.actor ?? item?.name ?? item?.subject ?? item?.id ?? '').trim().toLowerCase();
            return !aliases.has(owner);
        });
        const values = Array.isArray(value) ? value : [value];
        for (const thought of values) {
            const text = String(thought ?? '').trim();
            if (text && !/^none$/i.test(text)) result.thoughts.push({ actor: id, thoughts: text });
        }
    };
    for (const operation of operations) {
        if (operation.op === 'actor.set') {
            const actor = result.actors[operation.id];
            // Validation guarantees this exists. Keep this guard so a malformed
            // caller cannot turn a missing actor into an arbitrary object path.
            if (!isPlainObject(actor)) throw new Error(`Actor ${operation.id} does not exist`);
            for (const [field, value] of Object.entries(operation.set)) {
                if (field === 'thoughts') setActorThoughts(operation.id, value);
                else if (['at', 'location', 'position'].includes(field)) {
                    for (const alias of ['at', 'location', 'position']) delete actor[alias];
                    actor[field] = deepClone(value);
                } else if (['doing', 'activity'].includes(field)) {
                    for (const alias of ['doing', 'activity']) delete actor[alias];
                    actor[field] = deepClone(value);
                } else actor[field] = deepClone(value);
            }
        } else if (operation.op === 'actor.clear') {
            const actor = result.actors[operation.id];
            if (!isPlainObject(actor)) throw new Error(`Actor ${operation.id} does not exist`);
            for (const field of operation.fields) {
                if (field === 'location') for (const alias of ['at', 'location', 'position']) delete actor[alias];
                else if (field === 'activity') for (const alias of ['doing', 'activity']) delete actor[alias];
                else if (field === 'thoughts') setActorThoughts(operation.id, 'None');
                else delete actor[field];
            }
        } else if (operation.op === 'actor.create') {
            if (hasOwn(result.actors, operation.id)) throw new Error(`Actor ${operation.id} already exists`);
            const actor = deepClone(operation.actor);
            const thoughts = actor.thoughts;
            delete actor.thoughts;
            result.actors[operation.id] = { id: operation.id, ...actor };
            if (thoughts !== undefined) setActorThoughts(operation.id, thoughts);
        } else if (operation.op === 'scene.set') {
            for (const [field, value] of Object.entries(operation.set)) result.scene[field] = deepClone(value);
        } else if (operation.op === 'scene.clear') {
            const defaults = { spotlight: [], openBeat: 'None', timePressure: 'None', environment: 'None', positions: {}, time: '' };
            for (const field of operation.fields) result.scene[field] = deepClone(defaults[field]);
        } else if (operation.op === 'scene.position.remove') {
            delete result.scene.positions[operation.id];
        } else if (operation.op === 'relation.set') {
            const key = relationKey(operation.a, operation.b);
            if (!isPlainObject(result.relations?.pairs)) result.relations = { pairs: {}, profiles: {} };
            if (!isPlainObject(result.relations.pairs[key])) {
                result.relations.pairs[key] = {
                    a: operation.a,
                    b: operation.b,
                    labelA: result.actors[operation.a]?.name ?? operation.a,
                    labelB: result.actors[operation.b]?.name ?? operation.b,
                    bond: 0,
                    sparks: 0,
                    grudge: 0,
                };
            }
            for (const [field, value] of Object.entries(operation.set)) result.relations.pairs[key][field] = value;
        } else if (operation.op === 'residue.set') {
            if (!Array.isArray(result.residue)) result.residue = [];
            if (operation.create) {
                if (result.residue.length >= MAX_RESIDUE_ENTRIES) throw new Error(`Residue is limited to ${MAX_RESIDUE_ENTRIES} entries`);
                result.residue.push(deepClone(operation.set));
                continue;
            }
            const target = residueEntries(result.residue).find((entry) => entry.id === operation.id);
            if (!target) throw new Error(`Residue ${operation.id} does not exist`);
            const record = isPlainObject(result.residue[target.index]) ? deepClone(result.residue[target.index]) : { event: String(result.residue[target.index] ?? '') };
            for (const [field, value] of Object.entries(operation.set)) {
                if (value === '') delete record[field];
                else record[field] = deepClone(value);
            }
            result.residue[target.index] = record;
        } else if (operation.op === 'residue.remove') {
            const target = residueEntries(result.residue).find((entry) => entry.id === operation.id);
            if (!target) throw new Error(`Residue ${operation.id} does not exist`);
            result.residue.splice(target.index, 1);
        } else {
            throw new Error(`Unsupported operation ${operation.op}`);
        }
    }
    return result;
}

function patchIdentityKeys(patch, messageIdentity, transactionId) {
    const keys = new Set();
    if (transactionId) keys.add(`tx:${transactionId}`);
    if (patch.tx) keys.add(`tx:${patch.tx}`);
    if (patch.transactionId) keys.add(`tx:${patch.transactionId}`);
    if (patch.id) keys.add(`tx:${patch.id}`);
    if (messageIdentity) keys.add(`message:${messageIdentity}`);
    if (keys.size === 0) keys.add(`patch:${stableHash(patch)}`);
    return [...keys];
}

function isDuplicate(state, keys) {
    const set = new Set(state.dedupe ?? []);
    if (keys.some((key) => set.has(key))) return true;
    return (state.history ?? []).some((entry) => keys.includes(`tx:${entry.transactionId}`) || (entry.messageId && keys.includes(`message:${entry.messageId}`)));
}

function conciseDiff(diff) {
    const paths = diff.forward.map((change) => change.path).filter((path) => path && !path.startsWith('meta.') && path !== 'head' && path !== 'ct');
    if (paths.length === 0) return 'NORMAL turn (no field changes)';
    return paths.slice(0, 5).join(', ') + (paths.length > 5 ? ` +${paths.length - 5} more` : '');
}

/**
 * Validate and atomically apply one M2 patch. `state` is never mutated. The
 * caller persists `result.state` only when `status === 'committed'`.
 */
export function applyTransaction(inputState, inputPatch, options = {}) {
    const before = migrateState(inputState, { now: options.now });
    const flashHandoff = options.flashHandoff === true;
    if (flashHandoff) return { ok: true, status: 'ignored', reason: 'flash_handoff', state: before, diff: { forward: [], inverse: [] } };

    const validation = validatePatchEnvelope(inputPatch, { state: before });
    if (!validation.ok) return { ok: false, status: 'rejected', reason: 'invalid_patch', errors: validation.errors, state: before, diff: { forward: [], inverse: [] } };
    const patch = validation.value;
    if (patch.mode === 'OOC' || patch.mode === 'FLASH') {
        return { ok: true, status: 'ignored', reason: patch.mode.toLowerCase(), state: before, patch, diff: { forward: [], inverse: [] } };
    }

    const messageIdentity = options.messageIdentity ? String(options.messageIdentity) : (patch.messageId ? String(patch.messageId) : '');
    const transactionId = transactionIdentity(patch, messageIdentity);
    const identityKeys = patchIdentityKeys(patch, messageIdentity, transactionId);
    if (isDuplicate(before, identityKeys)) {
        return { ok: true, status: 'duplicate', reason: 'duplicate_transaction', state: before, patch, transactionId, identityKeys, diff: { forward: [], inverse: [] } };
    }
    if (patch.base !== before.head) {
        return { ok: false, status: 'stale', reason: 'stale_base', expected: before.head, received: patch.base, state: before, patch, transactionId, identityKeys, diff: { forward: [], inverse: [] } };
    }

    let staged;
    try {
        staged = applyOperations(before, patch.ops);
    } catch (error) {
        return { ok: false, status: 'rejected', reason: 'apply_failed', errors: [String(error?.message ?? error)], state: before, patch, transactionId, identityKeys, diff: { forward: [], inverse: [] } };
    }
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    staged.ct = before.ct + 1;
    staged.meta.ct = staged.ct;
    staged.meta.mode = 'NORMAL';
    staged.meta.updatedAt = now;
    staged.head = `h-${staged.ct}-${stableHash({ base: before.head, ct: staged.ct, transactionId, ops: patch.ops, state: staged })}`;
    staged.meta.head = staged.head;
    const diff = makeDiff(before, staged);
    const historyEntry = {
        id: `commit:${staged.ct}:${stableHash({ transactionId, head: staged.head })}`,
        transactionId,
        messageId: messageIdentity || null,
        base: before.head,
        head: staged.head,
        ct: staged.ct,
        mode: 'NORMAL',
        timestamp: now,
        summary: conciseDiff(diff),
        diff: deepClone(diff),
        ops: deepClone(patch.ops),
    };
    staged.history = [...(before.history ?? []), historyEntry].slice(-MAX_HISTORY);
    staged.dedupe = [...(before.dedupe ?? []), ...identityKeys].slice(-MAX_HISTORY * 2);
    return {
        ok: true,
        status: 'committed',
        state: staged,
        patch,
        transactionId,
        identityKeys,
        historyEntry,
        diff,
    };
}

export function applyPatchTransaction(inputState, inputPatch, options = {}) {
    return applyTransaction(inputState, inputPatch, options);
}

export function summarizeDiff(diff) {
    return conciseDiff(diff ?? { forward: [] });
}

export function relationIdentity(left, right) {
    return relationKey(left, right);
}

/**
 * Record a swipe/edit/delete marker without changing canonical state, ct, or
 * commit history. This is deliberately bookkeeping only; branch rollback UI is
 * outside M2.
 */
export function recordBranchEvent(inputState, { kind = 'other', messageId = '', detail = undefined, at = Date.now() } = {}) {
    const state = migrateState(inputState);
    const bucket = ['swipes', 'edits', 'deletes'].includes(kind) ? kind : 'edits';
    if (!isPlainObject(state.branches)) state.branches = { swipes: {}, edits: {}, deletes: {} };
    if (!Array.isArray(state.branches[bucket])) state.branches[bucket] = [];
    state.branches[bucket] = [...state.branches[bucket], { messageId: String(messageId), at, detail: deepClone(detail) }].slice(-MAX_HISTORY);
    return state;
}

