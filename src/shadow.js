import { deepClone, deepEqual, stableHash } from './util.js';

/** Fields that the evaluative patch contract can compare safely. */
export const SHADOW_SUPPORTED_ROOTS = Object.freeze(['ct', 'actors', 'scene']);
export const SHADOW_ACTOR_FIELDS = Object.freeze([
    'id', 'name', 'displayName', 'at', 'location', 'position', 'doing', 'activity',
    'agenda', 'agendaGoal', 'agendaStep', 'agendaMax', 'valence', 'arousal', 'dominance',
    'focus', 'aware', 'fibs', 'circle', 'body', 'spotlight',
]);
export const SHADOW_SCENE_FIELDS = Object.freeze(['spotlight', 'openBeat', 'timePressure', 'environment', 'positions', 'time']);

const UNSUPPORTED_ROOTS = Object.freeze([
    'meta', 'head', 'schemaVersion', 'version', 'factions', 'relations', 'residue', 'quests',
    'inventory', 'chekhov', 'thoughts', 'notebook', 'lastDnd', 'clocks', 'knowledge',
    'commitments', 'artifacts', 'worldSim', 'opaque', 'history', 'dedupe', 'branches',
]);

function actorRef(value, state) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    if (state?.actors?.[text]) return text;
    const lower = text.toLowerCase();
    return Object.entries(state?.actors ?? {}).find(([id, actor]) => id.toLowerCase() === lower
        || String(actor?.name ?? '').trim().toLowerCase() === lower
        || String(actor?.displayName ?? '').trim().toLowerCase() === lower)?.[0] ?? text;
}

function comparableActor(actor, id) {
    const source = actor && typeof actor === 'object' ? actor : {};
    const result = { id: String(id) };
    for (const field of SHADOW_ACTOR_FIELDS) {
        if (field === 'id') continue;
        if (field === 'at' || field === 'location') continue;
        if (field === 'doing' || field === 'activity') continue;
        if (Object.prototype.hasOwnProperty.call(source, field)) {
            const value = source[field];
            if (!(typeof value === 'string' && value.trim().toLowerCase() === 'none')) result[field] = deepClone(value);
        }
    }
    // The legacy importer calls these fields `at` and `doing`; the patch
    // contract also permits `location` and `activity`. Compare aliases as one
    // semantic path so naming alone never creates a false divergence.
    const location = source.location ?? source.at;
    const activity = source.activity ?? source.doing;
    if (location !== undefined && !(typeof location === 'string' && location.trim().toLowerCase() === 'none')) result.location = deepClone(location);
    if (activity !== undefined && !(typeof activity === 'string' && activity.trim().toLowerCase() === 'none')) result.activity = deepClone(activity);
    return result;
}

function comparableScene(scene, state) {
    const source = scene && typeof scene === 'object' ? scene : {};
    const result = {};
    for (const field of SHADOW_SCENE_FIELDS) {
        if (field === 'spotlight' || field === 'positions') continue;
        if (Object.prototype.hasOwnProperty.call(source, field)) result[field] = deepClone(source[field]);
    }
    const spotlight = Array.isArray(source.spotlight)
        ? source.spotlight.map((value) => actorRef(value, state))
        : (source.spotlight ? [actorRef(source.spotlight, state)] : []);
    result.spotlight = spotlight.filter(Boolean);
    result.positions = Object.fromEntries(Object.entries(source.positions ?? {})
        .map(([id, value]) => [actorRef(id, state), value])
        .filter(([id]) => id));
    return result;
}

export function shadowComparable(state) {
    const source = state && typeof state === 'object' ? state : {};
    return {
        ct: Number.isInteger(source.ct) ? source.ct : 0,
        actors: Object.fromEntries(Object.entries(source.actors ?? {}).sort(([left], [right]) => left.localeCompare(right))
            .map(([id, actor]) => [id, comparableActor(actor, id)])),
        scene: comparableScene(source.scene, source),
    };
}

function flatten(value, prefix = '', output = {}) {
    if (Array.isArray(value)) {
        output[prefix] = deepClone(value);
        return output;
    }
    if (!value || typeof value !== 'object') {
        output[prefix] = deepClone(value);
        return output;
    }
    const keys = Object.keys(value);
    if (keys.length === 0) output[prefix] = {};
    for (const key of keys) flatten(value[key], prefix ? `${prefix}.${key}` : key, output);
    return output;
}

function actorComparablePath(id, field) {
    if (field === 'at' || field === 'location') return `actors.${id}.location`;
    if (field === 'doing' || field === 'activity') return `actors.${id}.activity`;
    return `actors.${id}.${field}`;
}

/** Return only semantic paths explicitly claimed by a candidate delta. */
export function shadowClaimedPaths(patch) {
    const paths = new Set(['ct']);
    for (const operation of patch?.ops ?? []) {
        if (operation?.op === 'actor.set') {
            for (const field of Object.keys(operation.set ?? {})) paths.add(actorComparablePath(operation.id, field));
        } else if (operation?.op === 'actor.create') {
            paths.add(`actors.${operation.id}.id`);
            for (const field of Object.keys(operation.actor ?? {})) paths.add(actorComparablePath(operation.id, field));
        } else if (operation?.op === 'scene.set') {
            for (const field of Object.keys(operation.set ?? {})) paths.add(`scene.${field}`);
        }
    }
    return [...paths].sort();
}

/**
 * Compare a dry-run candidate with the imported legacy state. Only actor,
 * scene, and turn-counter paths are claims of this evaluator. Every other
 * domain is explicitly reported as unsupported rather than treated as a
 * parity failure.
 */
export function compareShadowParity(authoritative, candidate, { patchStatus = 'committed', at = Date.now(), patch = null } = {}) {
    const expected = shadowComparable(authoritative);
    if (!candidate) {
        return {
            version: 1,
            mode: 'SHADOW',
            at,
            status: 'not_comparable',
            equal: false,
            patchStatus: String(patchStatus),
            supportedRoots: [...SHADOW_SUPPORTED_ROOTS],
            supportedPaths: [],
            matches: [],
            mismatches: [],
            unsupported: [...UNSUPPORTED_ROOTS],
            unsupportedDomains: [...UNSUPPORTED_ROOTS],
            authoritativeCt: expected.ct,
            candidateCt: null,
            authoritativeDigest: stableHash(expected),
            candidateDigest: '',
        };
    }
    const actual = shadowComparable(candidate);
    const expectedFlat = flatten(expected);
    const actualFlat = flatten(actual);
    const paths = patch
        ? shadowClaimedPaths(patch)
        : [...new Set([...Object.keys(expectedFlat), ...Object.keys(actualFlat)])].sort();
    const mismatches = [];
    const matches = [];
    for (const path of paths) {
        if (deepEqual(expectedFlat[path], actualFlat[path])) matches.push(path);
        else mismatches.push({ path, expected: deepClone(expectedFlat[path]), actual: deepClone(actualFlat[path]) });
    }
    const unsupported = [...UNSUPPORTED_ROOTS];
    const status = mismatches.length ? 'diverged' : 'match';
    return {
        version: 1,
        mode: 'SHADOW',
        at,
        status,
        equal: mismatches.length === 0,
        patchStatus: String(patchStatus),
        supportedRoots: [...SHADOW_SUPPORTED_ROOTS],
        supportedPaths: paths,
        supportedPaths: paths,
        matches,
        mismatches,
        unsupported,
        unsupportedDomains: unsupported,
        authoritativeCt: expected.ct,
        candidateCt: actual.ct,
        authoritativeDigest: stableHash(expected),
        candidateDigest: stableHash(actual),
    };
}

export function makeShadowSidecar(report, { transactionId = '', messageId = '', at = Date.now() } = {}) {
    const sidecar = {
        version: 1,
        mode: 'SHADOW',
        at,
        status: report?.status ?? 'unknown',
        equal: report?.equal === true,
        patchStatus: report?.patchStatus ?? 'unknown',
        supportedRoots: [...(report?.supportedRoots ?? SHADOW_SUPPORTED_ROOTS)],
        matches: deepClone(report?.matches ?? []),
        mismatches: deepClone(report?.mismatches ?? []),
        unsupported: deepClone(report?.unsupported ?? UNSUPPORTED_ROOTS),
        unsupportedDomains: deepClone(report?.unsupportedDomains ?? UNSUPPORTED_ROOTS),
        authoritativeCt: report?.authoritativeCt,
        candidateCt: report?.candidateCt,
        authoritativeDigest: report?.authoritativeDigest ?? '',
        candidateDigest: report?.candidateDigest ?? '',
    };
    if (transactionId) sidecar.transactionId = String(transactionId);
    if (messageId) sidecar.messageId = String(messageId);
    return sidecar;
}

export function shadowHandshake(state, { mode = 'SHADOW' } = {}) {
    const current = state && typeof state === 'object' ? state : {};
    const normalized = String(mode).trim().toUpperCase();
    return [
        'ST_STATE_HANDSHAKE v1',
        'contract=3',
        'schema=2',
        `mode=${normalized}`,
        'preset=ST-ENDGAME',
        'legacy=internal_states',
        'patch=ST_PATCH',
        'flash=flash_handoff',
        `stateCt=${Number.isInteger(current.ct) ? current.ct : 0}`,
        `stateHead=${String(current.head ?? '')}`,
        'features=actor,scene',
        'END_ST_STATE_HANDSHAKE',
    ].join('\n');
}
