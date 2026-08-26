import { deepClone, hasOwn, isPlainObject, sanitizePlainText, sanitizeTextOrArray, stableHash } from './util.js';
import { isValidActorId, normalizeActorId } from './identity.js';

export const SCHEMA_VERSION = 2;
export const EXTENSION_KEY = 'ff5Engine';
export const INITIAL_HEAD = 'GENESIS';
export const MAX_HISTORY = 100;

const ACTOR_FIELDS = new Set([
    'id', 'name', 'displayName', 'at', 'location', 'position', 'doing', 'activity',
    'agenda', 'agendaGoal', 'agendaStep', 'agendaMax', 'valence', 'arousal', 'dominance',
    'focus', 'aware', 'fibs', 'circle', 'body', 'spotlight',
]);

const SCENE_FIELDS = new Set(['spotlight', 'openBeat', 'timePressure', 'environment', 'positions', 'time']);

function safeList(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => {
        if (typeof item === 'string') return sanitizePlainText(item);
        return isPlainObject(item) ? deepClone(item) : String(item);
    }).filter((item) => (typeof item === 'string' ? item.length > 0 : item !== null));
}

function safeRecord(value) {
    if (!isPlainObject(value)) return {};
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (!key || key.length > 100 || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        result[key] = deepClone(item);
    }
    return result;
}

export function relationKey(left, right) {
    return `${normalizeActorId(left)}|${normalizeActorId(right)}`;
}

export function createEmptyState(seed = {}) {
    const now = Number.isFinite(seed.now) ? seed.now : Date.now();
    const state = {
        schemaVersion: SCHEMA_VERSION,
        version: SCHEMA_VERSION,
        meta: {
            ct: 0,
            head: INITIAL_HEAD,
            mode: 'NORMAL',
            createdAt: now,
            updatedAt: now,
            title: '',
        },
        ct: 0,
        head: INITIAL_HEAD,
        scene: {
            spotlight: [],
            openBeat: 'None',
            timePressure: 'None',
            environment: 'None',
            positions: {},
            time: '',
        },
        actors: {},
        factions: {},
        relations: {
            pairs: {},
            profiles: {},
        },
        residue: [],
        quests: [],
        inventory: {
            items: [],
            titlesSkills: [],
            status: [],
            modifiers: [],
        },
        chekhov: {
            active: [],
            locked: [],
            fired: [],
        },
        thoughts: [],
        notebook: [],
        lastDnd: null,
        clocks: [],
        knowledge: [],
        commitments: [],
        artifacts: [],
        worldSim: {
            raw: '',
            data: null,
        },
        opaque: {
            legacy: {
                sections: {},
                unparsed: {},
                worldSimRaw: '',
                actorIds: {},
            },
            unknownRoot: {},
        },
        history: [],
        dedupe: [],
        branches: {
            swipes: {},
            edits: {},
            deletes: {},
        },
    };
    if (isPlainObject(seed.state)) return normalizeState(seed.state, state);
    return state;
}

function normalizeString(value, fallback = '') {
    if (value === null || value === undefined) return fallback;
    return sanitizePlainText(value, { maxLength: 4000 });
}

function normalizeScalarOrList(value) {
    if (Array.isArray(value)) return sanitizeTextOrArray(value, { maxLength: 1000, preserveNewlines: false });
    return normalizeString(value);
}

function normalizeActor(id, input = {}) {
    const actor = isPlainObject(input) ? input : {};
    const result = { id, name: normalizeString(actor.name ?? actor.displayName ?? id, id) };
    for (const field of ACTOR_FIELDS) {
        if (field === 'id' || field === 'name' || !hasOwn(actor, field)) continue;
        const value = actor[field];
        if (['focus', 'aware', 'fibs', 'circle', 'spotlight'].includes(field)) result[field] = normalizeScalarOrList(value);
        else if (['valence', 'arousal', 'dominance', 'agendaStep', 'agendaMax'].includes(field) && typeof value === 'number' && Number.isFinite(value)) result[field] = value;
        else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result[field] = typeof value === 'string' ? normalizeString(value) : value;
    }
    const unknown = {};
    for (const [key, value] of Object.entries(actor)) {
        if (!ACTOR_FIELDS.has(key) && key !== 'opaque') unknown[key] = deepClone(value);
    }
    if (isPlainObject(actor.opaque) || Object.keys(unknown).length > 0) result.opaque = { ...safeRecord(actor.opaque), ...unknown };
    return result;
}

function normalizeScene(input = {}) {
    const scene = isPlainObject(input) ? input : {};
    const result = {
        spotlight: Array.isArray(scene.spotlight) ? sanitizeTextOrArray(scene.spotlight, { maxLength: 200, preserveNewlines: false }) : (scene.spotlight ? [normalizeString(scene.spotlight, '')] : []),
        openBeat: normalizeString(scene.openBeat, 'None') || 'None',
        timePressure: normalizeString(scene.timePressure, 'None') || 'None',
        environment: normalizeString(scene.environment, 'None') || 'None',
        positions: {},
        time: normalizeString(scene.time, ''),
    };
    if (isPlainObject(scene.positions)) {
        for (const [id, value] of Object.entries(scene.positions)) {
            const normalized = normalizeActorId(id);
            if (isValidActorId(normalized)) result.positions[normalized] = normalizeString(value);
        }
    }
    return result;
}

function normalizeRelations(input = {}) {
    const source = isPlainObject(input) ? input : {};
    const pairsSource = isPlainObject(source.pairs) ? source.pairs : (isPlainObject(source) ? source : {});
    const pairs = {};
    const profiles = isPlainObject(source.profiles) ? safeRecord(source.profiles) : {};
    for (const [key, value] of Object.entries(pairsSource)) {
        if (key === 'profiles') continue;
        const relation = isPlainObject(value) ? value : {};
        const ids = key.split('|').map(normalizeActorId);
        const left = isValidActorId(ids[0]) ? ids[0] : normalizeActorId(relation.a ?? relation.from);
        const right = isValidActorId(ids[1]) ? ids[1] : normalizeActorId(relation.b ?? relation.to);
        if (!isValidActorId(left) || !isValidActorId(right) || left === right) continue;
        const normalizedKey = relationKey(left, right);
        const bond = Number.isFinite(relation.bond) ? Math.max(-5, Math.min(20, Math.trunc(relation.bond))) : 0;
        const sparks = Number.isFinite(relation.sparks) ? Math.max(0, Math.min(100, Math.trunc(relation.sparks))) : 0;
        const grudge = Number.isFinite(relation.grudge) ? Math.max(0, Math.min(100, Math.trunc(relation.grudge))) : 0;
        pairs[normalizedKey] = {
            a: left,
            b: right,
            labelA: normalizeString(relation.labelA ?? ''),
            labelB: normalizeString(relation.labelB ?? ''),
            bond,
            sparks,
            grudge,
            profile: isPlainObject(relation.profile) ? deepClone(relation.profile) : undefined,
        };
        if (!pairs[normalizedKey].profile) delete pairs[normalizedKey].profile;
    }
    // Some early drafts kept directional profiles only in
    // `relations.profiles`. Materialize a neutral pair so import/export and
    // dashboards cannot drop those semantic links.
    for (const [profileKey, value] of Object.entries(profiles)) {
        const profile = isPlainObject(value) ? value : {};
        const from = normalizeActorId(profile.from ?? profileKey.split('->')[0]);
        const to = normalizeActorId(profile.to ?? profileKey.split('->')[1]);
        if (!isValidActorId(from) || !isValidActorId(to) || from === to) continue;
        const key = relationKey(from, to);
        if (!pairs[key]) pairs[key] = { a: from, b: to, labelA: '', labelB: '', bond: 0, sparks: 0, grudge: 0 };
        if (!isPlainObject(pairs[key].profile)) pairs[key].profile = {};
        pairs[key].profile[profileKey] = deepClone(profile);
    }
    return { pairs, profiles };
}

function normalizeInventory(input = {}) {
    const value = isPlainObject(input) ? input : {};
    return {
        items: safeList(value.items ?? value.inv),
        titlesSkills: safeList(value.titlesSkills ?? value.skills ?? value.titles),
        status: safeList(value.status ?? value.conditions),
        modifiers: safeList(value.modifiers ?? value.mods),
    };
}

function normalizeChekhov(input = {}) {
    const value = isPlainObject(input) ? input : {};
    return { active: safeList(value.active), locked: safeList(value.locked), fired: safeList(value.fired) };
}

function normalizeMeta(raw, fallback) {
    const meta = isPlainObject(raw) ? raw : {};
    const ctValue = Number.isInteger(meta.ct) && meta.ct >= 0 ? meta.ct : fallback.ct;
    const head = typeof meta.head === 'string' && meta.head.length > 0 ? meta.head.slice(0, 200) : fallback.head;
    return {
        ct: ctValue,
        head,
        mode: ['NORMAL', 'OOC', 'FLASH'].includes(meta.mode) ? meta.mode : 'NORMAL',
        createdAt: Number.isFinite(meta.createdAt) ? meta.createdAt : fallback.meta.createdAt,
        updatedAt: Number.isFinite(meta.updatedAt) ? meta.updatedAt : fallback.meta.updatedAt,
        title: normalizeString(meta.title, ''),
    };
}

/** Normalize any persisted/legacy-shaped document into the current schema. */
export function normalizeState(input, fallback = createEmptyState()) {
    const raw = isPlainObject(input) ? input : {};
    const state = deepClone(fallback);
    const rawMeta = isPlainObject(raw.meta) ? raw.meta : {};
    const sourceCt = Number.isInteger(raw.ct) && raw.ct >= 0 ? raw.ct : (Number.isInteger(rawMeta.ct) && rawMeta.ct >= 0 ? rawMeta.ct : 0);
    const sourceHead = typeof raw.head === 'string' && raw.head.length > 0 ? raw.head : (typeof rawMeta.head === 'string' && rawMeta.head.length > 0 ? rawMeta.head : INITIAL_HEAD);
    state.ct = sourceCt;
    state.head = sourceHead.slice(0, 200);
    state.meta = normalizeMeta({ ...rawMeta, ct: state.ct, head: state.head }, state);
    state.scene = normalizeScene(raw.scene);
    const actorsSource = isPlainObject(raw.actors) ? raw.actors : {};
    for (const [id, actor] of Object.entries(actorsSource)) {
        const normalizedId = normalizeActorId(id);
        if (isValidActorId(normalizedId)) state.actors[normalizedId] = normalizeActor(normalizedId, actor);
    }
    state.factions = safeRecord(raw.factions);
    state.relations = normalizeRelations(raw.relations);
    state.residue = safeList(raw.residue);
    state.quests = safeList(raw.quests);
    state.inventory = normalizeInventory(raw.inventory);
    state.chekhov = normalizeChekhov(raw.chekhov);
    state.thoughts = safeList(raw.thoughts);
    state.notebook = safeList(raw.notebook);
    state.lastDnd = raw.lastDnd === null || raw.lastDnd === undefined ? null : deepClone(raw.lastDnd);
    state.clocks = safeList(raw.clocks);
    state.knowledge = safeList(raw.knowledge);
    state.commitments = safeList(raw.commitments);
    state.artifacts = safeList(raw.artifacts);
    state.worldSim = typeof raw.worldSim === 'string'
        ? { raw: raw.worldSim, data: null }
        : (isPlainObject(raw.worldSim) ? deepClone(raw.worldSim) : { raw: '', data: null });
    state.opaque = isPlainObject(raw.opaque) ? deepClone(raw.opaque) : state.opaque;
    if (!isPlainObject(state.opaque.legacy)) state.opaque.legacy = { sections: {}, unparsed: {}, worldSimRaw: '', actorIds: {} };
    if (!isPlainObject(state.opaque.legacy.sections)) state.opaque.legacy.sections = {};
    if (!isPlainObject(state.opaque.legacy.unparsed)) state.opaque.legacy.unparsed = {};
    if (typeof state.opaque.legacy.worldSimRaw !== 'string') state.opaque.legacy.worldSimRaw = '';
    if (!isPlainObject(state.opaque.legacy.actorIds)) state.opaque.legacy.actorIds = {};
    else {
        const actorIds = {};
        for (const [label, id] of Object.entries(state.opaque.legacy.actorIds)) {
            const cleanLabel = sanitizePlainText(label, { maxLength: 200, preserveNewlines: false });
            const cleanId = normalizeActorId(id);
            if (cleanLabel && isValidActorId(cleanId)) actorIds[cleanLabel] = cleanId;
        }
        state.opaque.legacy.actorIds = actorIds;
    }
    state.history = Array.isArray(raw.history) ? raw.history.slice(-MAX_HISTORY).map((entry) => deepClone(entry)) : [];
    state.dedupe = Array.isArray(raw.dedupe) ? raw.dedupe.slice(-MAX_HISTORY).map((entry) => String(entry)) : [];
    state.branches = isPlainObject(raw.branches) ? deepClone(raw.branches) : state.branches;
    // Preserve root fields introduced by a future schema instead of silently dropping them.
    const known = new Set(Object.keys(state));
    const unknownRoot = isPlainObject(state.opaque.unknownRoot) ? state.opaque.unknownRoot : {};
    for (const [key, value] of Object.entries(raw)) {
        if (!known.has(key) && key !== 'version' && key !== 'schemaVersion') unknownRoot[key] = deepClone(value);
    }
    state.opaque.unknownRoot = unknownRoot;
    state.schemaVersion = SCHEMA_VERSION;
    state.version = SCHEMA_VERSION;
    state.meta.ct = state.ct;
    state.meta.head = state.head;
    return state;
}

export function migrateState(input, options = {}) {
    const fallback = createEmptyState(options);
    if (!isPlainObject(input)) return fallback;
    const version = Number(input.schemaVersion ?? input.version ?? 0);
    // M0/M1 drafts used `version` and occasionally nested meta counters. The
    // normalizer intentionally accepts those shapes and emits one v2 document.
    const migrated = normalizeState(input, fallback);
    migrated.schemaVersion = SCHEMA_VERSION;
    if (!Number.isFinite(version) || version < 0) migrated.opaque.migrationWarning = 'Unrecognised source schema version; normalized conservatively.';
    if (version > SCHEMA_VERSION) migrated.opaque.migrationWarning = `Future schema ${version} imported read-only; unknown fields retained.`;
    return migrated;
}

export function isStateDocument(value) {
    return isPlainObject(value)
        && value.schemaVersion === SCHEMA_VERSION
        && Number.isInteger(value.ct)
        && typeof value.head === 'string'
        && isPlainObject(value.actors)
        && isPlainObject(value.scene);
}

export function stateSummary(state) {
    const current = migrateState(state);
    return {
        schemaVersion: current.schemaVersion,
        ct: current.ct,
        head: current.head,
        actors: Object.keys(current.actors).length,
        relations: Object.keys(current.relations.pairs).length,
        history: current.history.length,
        digest: stableHash({ ct: current.ct, head: current.head, scene: current.scene, actors: current.actors }),
    };
}

export const ALLOWLISTED_ACTOR_FIELDS = Object.freeze([...ACTOR_FIELDS].filter((field) => field !== 'id'));
export const ALLOWLISTED_SCENE_FIELDS = Object.freeze([...SCENE_FIELDS]);

