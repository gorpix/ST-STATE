import { ALLOWLISTED_ACTOR_FIELDS, ALLOWLISTED_SCENE_FIELDS, SCHEMA_VERSION } from './schema.js';
import { isValidActorId } from './identity.js';
import { deepClone, hasOwn, isPlainObject, sanitizePlainText } from './util.js';

export const PATCH_MODES = Object.freeze(['NORMAL', 'OOC', 'FLASH']);
export const PATCH_VERSION = SCHEMA_VERSION;
export const MAX_PATCH_OPS = 50;
export const MAX_PATCH_TEXT = 4000;

export class PatchValidationError extends Error {
    constructor(errors, message = 'ST-STATE patch validation failed') {
        super(message);
        this.name = 'PatchValidationError';
        this.errors = [...errors];
    }
}

const ENVELOPE_KEYS = new Set(['version', 'base', 'head', 'mode', 'ops', 'tx', 'id', 'transactionId', 'messageId']);
const ACTOR_OP_KEYS = new Set(['op', 'id', 'field', 'value', 'set', 'fields']);
const CREATE_OP_KEYS = new Set(['op', 'id', 'actor', 'set', 'fields']);
const SCENE_OP_KEYS = new Set(['op', 'field', 'value', 'set', 'fields']);

function fail(errors, path, message) {
    errors.push(`${path}: ${message}`);
}

function checkKeys(value, allowed, path, errors) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) fail(errors, path, `unknown field "${key}"`);
    }
}

function validateText(value, path, errors, { allowEmpty = true, maxLength = MAX_PATCH_TEXT } = {}) {
    if (typeof value !== 'string') {
        fail(errors, path, 'must be a string');
        return '';
    }
    if (!allowEmpty && sanitizePlainText(value, { maxLength }).length === 0) fail(errors, path, 'must not be empty');
    if (value.length > maxLength) fail(errors, path, `must be at most ${maxLength} characters`);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) fail(errors, path, 'contains control characters');
    return sanitizePlainText(value, { maxLength });
}

function validateTextList(value, path, errors, { maxItems = 20, maxLength = 1000 } = {}) {
    if (!Array.isArray(value)) {
        fail(errors, path, 'must be an array of strings');
        return [];
    }
    if (value.length > maxItems) fail(errors, path, `must contain at most ${maxItems} items`);
    return value.map((item, index) => validateText(item, `${path}[${index}]`, errors, { maxLength })).filter(Boolean);
}

function normalizeActorField(field, value, path, errors) {
    if (!ALLOWLISTED_ACTOR_FIELDS.includes(field)) {
        fail(errors, path, `field "${field}" is not allowlisted`);
        return undefined;
    }
    if (['valence', 'arousal', 'dominance'].includes(field)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < -2 || value > 2) fail(errors, path, 'must be a finite number from -2 through 2');
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    }
    if (['agendaStep', 'agendaMax'].includes(field)) {
        if (!Number.isInteger(value) || value < 0 || value > 100) fail(errors, path, 'must be an integer from 0 through 100');
        return Number.isInteger(value) ? value : 0;
    }
    if (['focus', 'aware', 'fibs', 'circle'].includes(field)) {
        if (Array.isArray(value)) return validateTextList(value, path, errors, { maxItems: 20, maxLength: 1000 });
        return validateText(value, path, errors, { maxLength: 2000 });
    }
    if (field === 'spotlight') {
        if (Array.isArray(value)) return validateTextList(value, path, errors, { maxItems: 20, maxLength: 200 });
        return validateText(value, path, errors, { maxLength: 200 });
    }
    return validateText(value, path, errors, { maxLength: field === 'name' || field === 'displayName' ? 200 : 2000 });
}

function normalizeSceneField(field, value, path, errors) {
    if (!ALLOWLISTED_SCENE_FIELDS.includes(field)) {
        fail(errors, path, `field "${field}" is not allowlisted`);
        return undefined;
    }
    if (field === 'spotlight') {
        if (Array.isArray(value)) return validateTextList(value, path, errors, { maxItems: 20, maxLength: 200 });
        return validateText(value, path, errors, { maxLength: 200 });
    }
    if (field === 'positions') {
        if (!isPlainObject(value)) {
            fail(errors, path, 'must be an object keyed by two-letter actor IDs');
            return {};
        }
        const result = {};
        for (const [id, position] of Object.entries(value)) {
            if (!isValidActorId(id)) fail(errors, `${path}.${id}`, 'must use a two-letter uppercase actor ID');
            result[id] = validateText(position, `${path}.${id}`, errors, { maxLength: 500 });
        }
        return result;
    }
    return validateText(value, path, errors, { maxLength: field === 'time' ? 100 : 4000 });
}

function extractOperationFields(operation, path, allowedKeys, errors) {
    checkKeys(operation, allowedKeys, path, errors);
    const hasSet = hasOwn(operation, 'set') || hasOwn(operation, 'fields');
    if (hasOwn(operation, 'set') && hasOwn(operation, 'fields')) fail(errors, path, 'use either set or fields, not both');
    const hasField = hasOwn(operation, 'field') || hasOwn(operation, 'value');
    if (hasSet && hasField) fail(errors, path, 'use either set or field/value, not both');
    if (!hasSet && !hasField) fail(errors, path, 'requires set or field/value');
    const setValue = operation.set ?? operation.fields;
    if (hasSet && !isPlainObject(setValue)) fail(errors, `${path}.set`, 'must be an object');
    if (hasField && (!hasOwn(operation, 'field') || !hasOwn(operation, 'value'))) fail(errors, path, 'field and value must be supplied together');
    return { hasSet, hasField, setValue };
}

function normalizeOperation(operation, index, knownActors, errors) {
    const path = `ops[${index}]`;
    if (!isPlainObject(operation)) {
        fail(errors, path, 'must be an object');
        return null;
    }
    if (typeof operation.op !== 'string') {
        fail(errors, `${path}.op`, 'must be a string');
        return null;
    }
    if (operation.op === 'actor.set') {
        const { hasSet, hasField, setValue } = extractOperationFields(operation, path, ACTOR_OP_KEYS, errors);
        if (!isValidActorId(operation.id)) fail(errors, `${path}.id`, 'must be a two-letter uppercase actor ID');
        if (isValidActorId(operation.id) && !knownActors.has(operation.id)) fail(errors, `${path}.id`, 'actor does not exist in the base state or an earlier actor.create');
        const fields = {};
        if (hasSet && isPlainObject(setValue)) {
            for (const [field, value] of Object.entries(setValue)) {
                const normalized = normalizeActorField(field, value, `${path}.set.${field}`, errors);
                if (normalized !== undefined) fields[field] = normalized;
            }
        }
        if (hasField) {
            const normalized = normalizeActorField(operation.field, operation.value, `${path}.value`, errors);
            if (normalized !== undefined) fields[operation.field] = normalized;
        }
        return { op: operation.op, id: operation.id, set: fields };
    }
    if (operation.op === 'actor.create') {
        checkKeys(operation, CREATE_OP_KEYS, path, errors);
        if (hasOwn(operation, 'actor') && (hasOwn(operation, 'set') || hasOwn(operation, 'fields'))) fail(errors, path, 'use either actor or set/fields, not both');
        if (!isValidActorId(operation.id) || operation.id === 'US') fail(errors, `${path}.id`, 'must be a stable two-letter uppercase ID other than US');
        if (isValidActorId(operation.id) && knownActors.has(operation.id)) fail(errors, `${path}.id`, 'actor ID already exists');
        const actorInput = operation.actor ?? operation.set ?? operation.fields;
        if (!isPlainObject(actorInput)) fail(errors, `${path}.actor`, 'must be an object');
        const actor = {};
        if (isPlainObject(actorInput)) {
            for (const key of Object.keys(actorInput)) {
                if (key === 'id') fail(errors, `${path}.actor.id`, 'actor ID is supplied by the operation');
                const normalized = normalizeActorField(key, actorInput[key], `${path}.actor.${key}`, errors);
                if (normalized !== undefined) actor[key] = normalized;
            }
            if (!hasOwn(actor, 'name') || !actor.name) fail(errors, `${path}.actor.name`, 'is required');
        }
        if (isValidActorId(operation.id) && operation.id !== 'US') knownActors.add(operation.id);
        return { op: operation.op, id: operation.id, actor };
    }
    if (operation.op === 'scene.set') {
        const { hasSet, hasField, setValue } = extractOperationFields(operation, path, SCENE_OP_KEYS, errors);
        const set = {};
        if (hasSet && isPlainObject(setValue)) {
            for (const [field, value] of Object.entries(setValue)) {
                const normalized = normalizeSceneField(field, value, `${path}.set.${field}`, errors);
                if (normalized !== undefined) set[field] = normalized;
            }
        }
        if (hasField) {
            const normalized = normalizeSceneField(operation.field, operation.value, `${path}.value`, errors);
            if (normalized !== undefined) set[operation.field] = normalized;
        }
        return { op: operation.op, set };
    }
    fail(errors, path, `unknown operation "${operation.op}"`);
    return null;
}

/**
 * Validate and sanitize a complete M2 patch. No reducer is called here, which
 * makes it safe to validate every operation before an atomic commit.
 */
export function validatePatchEnvelope(input, { state = null } = {}) {
    const errors = [];
    let patch = input;
    if (typeof patch === 'string') {
        try { patch = JSON.parse(patch); } catch { fail(errors, '$', 'must contain valid JSON'); }
    }
    if (!isPlainObject(patch)) {
        fail(errors, '$', 'must be an object');
        return { ok: false, errors, value: null };
    }
    checkKeys(patch, ENVELOPE_KEYS, '$', errors);
    if (![1, SCHEMA_VERSION].includes(patch.version)) fail(errors, '$.version', `must equal 1 or ${SCHEMA_VERSION}`);
    const base = validateText(patch.base, '$.base', errors, { allowEmpty: false, maxLength: 200 });
    if (!PATCH_MODES.includes(patch.mode)) fail(errors, '$.mode', 'must be NORMAL, OOC, or FLASH');
    if (!Array.isArray(patch.ops)) fail(errors, '$.ops', 'must be an array');
    if (Array.isArray(patch.ops) && patch.ops.length > MAX_PATCH_OPS) fail(errors, '$.ops', `must contain at most ${MAX_PATCH_OPS} operations`);
    const knownActors = new Set(Object.keys(state?.actors ?? {}).filter(isValidActorId));
    const operations = [];
    if (Array.isArray(patch.ops)) {
        for (let index = 0; index < patch.ops.length; index += 1) {
            const normalized = normalizeOperation(patch.ops[index], index, knownActors, errors);
            if (normalized) operations.push(normalized);
        }
    }
    for (const key of ['head', 'tx', 'id', 'transactionId', 'messageId']) {
        if (hasOwn(patch, key) && patch[key] !== null && patch[key] !== undefined) validateText(patch[key], `$.${key}`, errors, { allowEmpty: false, maxLength: 200 });
    }
    if (errors.length > 0) return { ok: false, errors, value: null };
    return {
        ok: true,
        errors: [],
        value: {
            version: SCHEMA_VERSION,
            base,
            ...(patch.head === null || patch.head === undefined ? {} : { head: String(patch.head).trim().slice(0, 200) }),
            mode: patch.mode,
            ops: operations,
            ...(patch.tx === undefined ? {} : { tx: String(patch.tx).trim().slice(0, 200) }),
            ...(patch.id === undefined ? {} : { id: String(patch.id).trim().slice(0, 200) }),
            ...(patch.transactionId === undefined ? {} : { transactionId: String(patch.transactionId).trim().slice(0, 200) }),
            ...(patch.messageId === undefined ? {} : { messageId: String(patch.messageId).trim().slice(0, 200) }),
        },
    };
}

export function assertValidPatchEnvelope(input, options = {}) {
    const result = validatePatchEnvelope(input, options);
    if (!result.ok) throw new PatchValidationError(result.errors);
    return result.value;
}

export function isSafePatch(input, options = {}) {
    return validatePatchEnvelope(input, options).ok;
}

export function cloneValidatedPatch(patch) {
    return deepClone(patch);
}

