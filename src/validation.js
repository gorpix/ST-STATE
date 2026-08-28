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
const RELATION_OP_KEYS = new Set(['op', 'a', 'b', 'field', 'value', 'set', 'fields']);
const RELATION_FIELDS = Object.freeze(['bond', 'sparks', 'grudge']);

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

const VAD_COMPONENT_FIELDS = Object.freeze(['valence', 'arousal', 'dominance']);
const normalizeFieldTerm = (field) => typeof field === 'string' ? field.trim().toLowerCase().replace(/[\s_-]+/g, '') : '';
const ACTOR_FIELD_ALIASES = new Map(ALLOWLISTED_ACTOR_FIELDS.map((field) => [normalizeFieldTerm(field), field]));
const SCENE_FIELD_ALIASES = new Map(ALLOWLISTED_SCENE_FIELDS.map((field) => [normalizeFieldTerm(field), field]));
SCENE_FIELD_ALIASES.set('env', 'environment');

function isLegacyVadField(field) {
    return normalizeFieldTerm(field) === 'vad';
}

function canonicalActorField(field) {
    return isLegacyVadField(field) ? 'vad' : ACTOR_FIELD_ALIASES.get(normalizeFieldTerm(field));
}

function canonicalSceneField(field) {
    return SCENE_FIELD_ALIASES.get(normalizeFieldTerm(field));
}

function prepareFieldEntries(value, resolver, path, errors) {
    const entries = Object.entries(value).map(([field, fieldValue]) => ({ field, value: fieldValue, canonical: resolver(field) }));
    const seen = new Map();
    for (const entry of entries) {
        if (!entry.canonical) continue;
        if (seen.has(entry.canonical)) fail(errors, path, `fields "${seen.get(entry.canonical)}" and "${entry.field}" resolve to the same canonical field "${entry.canonical}"`);
        else seen.set(entry.canonical, entry.field);
    }
    return entries;
}

function normalizeLegacyVad(value, path, errors) {
    let parts;
    if (Array.isArray(value)) {
        parts = value;
    } else if (typeof value === 'string') {
        const source = value.trim().replace(/^([\[(])\s*/, '').replace(/\s*([\])])$/, '');
        const delimited = source.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*([/,|])\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*\2\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/);
        const spaced = source.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/);
        parts = delimited ? [delimited[1], delimited[3], delimited[4]] : spaced ? spaced.slice(1) : null;
    } else {
        parts = null;
    }
    if (!parts || parts.length !== VAD_COMPONENT_FIELDS.length) {
        fail(errors, path, 'legacy vad must contain exactly three numeric valence/arousal/dominance components');
        return null;
    }
    const numbers = parts.map((part) => typeof part === 'number' ? part : (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(part).trim()) ? Number(part) : Number.NaN));
    if (numbers.some((number) => !Number.isFinite(number) || number < -2 || number > 2)) {
        fail(errors, path, 'legacy vad components must each be finite numbers from -2 through 2');
        return null;
    }
    return Object.fromEntries(VAD_COMPONENT_FIELDS.map((field, index) => [field, numbers[index]]));
}

function assignActorField(fields, field, value, path, errors) {
    const canonicalField = canonicalActorField(field);
    if (canonicalField === 'vad') {
        if (VAD_COMPONENT_FIELDS.some((component) => hasOwn(fields, component))) {
            fail(errors, path, 'legacy vad cannot be combined with valence, arousal, or dominance in the same operation');
            return;
        }
        const normalized = normalizeLegacyVad(value, path, errors);
        if (normalized) Object.assign(fields, normalized);
        return;
    }
    if (!canonicalField) {
        fail(errors, path, `field "${field}" is not allowlisted`);
        return;
    }
    const normalized = normalizeActorField(canonicalField, value, path, errors);
    if (normalized !== undefined) fields[canonicalField] = normalized;
}

function normalizeActorField(field, value, path, errors) {
    if (!ALLOWLISTED_ACTOR_FIELDS.includes(field)) {
        fail(errors, path, `field "${field}" is not allowlisted`);
        return undefined;
    }
    if (['valence', 'arousal', 'dominance'].includes(field)) {
        const number = typeof value === 'number' ? value : (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(value).trim()) ? Number(value) : Number.NaN);
        if (!Number.isFinite(number) || number < -2 || number > 2) fail(errors, path, 'must be a finite number from -2 through 2');
        return Number.isFinite(number) ? number : 0;
    }
    if (['agendaStep', 'agendaMax'].includes(field)) {
        const number = typeof value === 'number' ? value : (/^\d+$/.test(String(value).trim()) ? Number(value) : Number.NaN);
        if (!Number.isInteger(number) || number < 0 || number > 100) fail(errors, path, 'must be an integer from 0 through 100');
        return Number.isInteger(number) ? number : 0;
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

function normalizeLegacyPositionString(value, state, path, errors) {
    const actors = Object.entries(state?.actors ?? {});
    const labels = actors.flatMap(([id, actor]) => [id, actor?.name, actor?.displayName]
        .filter(Boolean).map((label) => ({ id, label: String(label).trim() })))
        .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.id === entry.id && candidate.label.toLowerCase() === entry.label.toLowerCase()) === index);
    const shortCounts = new Map();
    for (const { label } of labels) {
        const short = label.match(/^([\p{L}\p{N}_'-]+)/u)?.[1] ?? '';
        if (short.length > 1) shortCounts.set(short.toLowerCase(), (shortCounts.get(short.toLowerCase()) ?? 0) + 1);
    }
    for (const { id, label } of [...labels]) {
        const short = label.match(/^([\p{L}\p{N}_'-]+)/u)?.[1] ?? '';
        if (short.length > 1 && shortCounts.get(short.toLowerCase()) === 1 && short.toLowerCase() !== label.toLowerCase()) labels.push({ id, label: short });
    }
    labels.sort((left, right) => right.label.length - left.label.length);
    const escapedLabels = labels.map(({ label }) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const actorClause = escapedLabels.length ? new RegExp(`,\\s*(?=(?:${escapedLabels.join('|')})\\s)`, 'iu') : null;
    const result = {};
    for (const rawPart of String(value).split(/[;\n]+/)) {
        const source = sanitizePlainText(rawPart, { maxLength: 2000, preserveNewlines: false }).trim();
        for (const part of actorClause ? source.split(actorClause) : [source]) {
            if (!part) continue;
            const explicit = part.match(/^(.+?)\s*[:=]\s*(.+)$/);
            const known = explicit
                ? labels.find(({ label }) => label.toLowerCase() === explicit[1].trim().toLowerCase())
                : labels.find(({ label }) => part.toLowerCase().startsWith(`${label.toLowerCase()} `));
            if (!known) continue;
            const position = explicit ? explicit[2].trim() : part.slice(known.label.length).trim().replace(/^[-–—:=>]+\s*/, '');
            if (position) result[known.id] = validateText(position, `${path}.${known.id}`, errors, { maxLength: 500 });
        }
    }
    if (!Object.keys(result).length) fail(errors, path, 'legacy position text must begin with at least one known actor name or ID');
    return result;
}

function normalizeSceneField(field, value, path, errors, state = null) {
    if (!ALLOWLISTED_SCENE_FIELDS.includes(field)) {
        fail(errors, path, `field "${field}" is not allowlisted`);
        return undefined;
    }
    if (field === 'spotlight') {
        if (Array.isArray(value)) return validateTextList(value, path, errors, { maxItems: 20, maxLength: 200 });
        return validateText(value, path, errors, { maxLength: 200 });
    }
    if (field === 'positions') {
        if (typeof value === 'string') return normalizeLegacyPositionString(value, state, path, errors);
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

function assignSceneField(fields, field, value, path, errors, state = null) {
    const canonicalField = canonicalSceneField(field);
    if (!canonicalField) {
        fail(errors, path, `field "${field}" is not allowlisted`);
        return;
    }
    const normalized = normalizeSceneField(canonicalField, value, path, errors, state);
    if (normalized !== undefined) fields[canonicalField] = normalized;
}

function assignRelationField(fields, field, value, path, errors) {
    const canonicalField = RELATION_FIELDS.find((candidate) => normalizeFieldTerm(candidate) === normalizeFieldTerm(field));
    if (!canonicalField) {
        fail(errors, path, `field "${field}" is not allowlisted`);
        return;
    }
    const number = typeof value === 'number' ? value : (/^-?\d+$/.test(String(value).trim()) ? Number(value) : Number.NaN);
    const minimum = canonicalField === 'bond' ? -5 : 0;
    const maximum = canonicalField === 'bond' ? 20 : 100;
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        fail(errors, path, `must be an integer from ${minimum} through ${maximum}`);
        return;
    }
    fields[canonicalField] = number;
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

function normalizeOperation(operation, index, knownActors, errors, state = null) {
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
            const entries = prepareFieldEntries(setValue, canonicalActorField, path, errors);
            const hasLegacyVad = entries.some((entry) => entry.canonical === 'vad');
            if (hasLegacyVad && entries.some((entry) => VAD_COMPONENT_FIELDS.includes(entry.canonical))) {
                fail(errors, path, 'legacy vad cannot be combined with valence, arousal, or dominance in the same operation');
            }
            for (const entry of entries) {
                if (hasLegacyVad && VAD_COMPONENT_FIELDS.includes(entry.canonical)) continue;
                assignActorField(fields, entry.field, entry.value, `${path}.set.${entry.field}`, errors);
            }
        }
        if (hasField) {
            assignActorField(fields, operation.field, operation.value, `${path}.value`, errors);
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
            const entries = prepareFieldEntries(actorInput, canonicalActorField, path, errors);
            const hasLegacyVad = entries.some((entry) => entry.canonical === 'vad');
            if (hasLegacyVad && entries.some((entry) => VAD_COMPONENT_FIELDS.includes(entry.canonical))) {
                fail(errors, path, 'legacy vad cannot be combined with valence, arousal, or dominance in the same operation');
            }
            for (const entry of entries) {
                if (normalizeFieldTerm(entry.field) === 'id') fail(errors, `${path}.actor.${entry.field}`, 'actor ID is supplied by the operation');
                if (hasLegacyVad && VAD_COMPONENT_FIELDS.includes(entry.canonical)) continue;
                assignActorField(actor, entry.field, entry.value, `${path}.actor.${entry.field}`, errors);
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
            const entries = prepareFieldEntries(setValue, canonicalSceneField, path, errors);
            for (const entry of entries) {
                assignSceneField(set, entry.field, entry.value, `${path}.set.${entry.field}`, errors, state);
            }
        }
        if (hasField) {
            assignSceneField(set, operation.field, operation.value, `${path}.value`, errors, state);
        }
        return { op: operation.op, set };
    }
    if (operation.op === 'relation.set') {
        const { hasSet, hasField, setValue } = extractOperationFields(operation, path, RELATION_OP_KEYS, errors);
        for (const side of ['a', 'b']) {
            if (!isValidActorId(operation[side])) fail(errors, `${path}.${side}`, 'must be a two-letter uppercase actor ID');
            else if (!knownActors.has(operation[side])) fail(errors, `${path}.${side}`, 'actor does not exist in the base state or an earlier actor.create');
        }
        if (operation.a === operation.b) fail(errors, path, 'relation endpoints must be different actors');
        const set = {};
        if (hasSet && isPlainObject(setValue)) {
            const entries = prepareFieldEntries(setValue, (field) => RELATION_FIELDS.find((candidate) => normalizeFieldTerm(candidate) === normalizeFieldTerm(field)), path, errors);
            for (const entry of entries) assignRelationField(set, entry.field, entry.value, `${path}.set.${entry.field}`, errors);
        }
        if (hasField) assignRelationField(set, operation.field, operation.value, `${path}.value`, errors);
        return { op: operation.op, a: operation.a, b: operation.b, set };
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
            const normalized = normalizeOperation(patch.ops[index], index, knownActors, errors, state);
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

