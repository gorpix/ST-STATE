import { migrateState } from './schema.js';
import { residueEntries } from './residue.js';
import { isPlainObject, sanitizePlainText, stableStringify } from './util.js';

const ACTOR_TEXT_FIELDS = Object.freeze(['focus', 'aware', 'fibs', 'circle', 'body']);
const ACTOR_NUMBER_FIELDS = Object.freeze(['agendaStep', 'agendaMax']);

function cleanText(value, maxLength = 1000) {
    return sanitizePlainText(value, { maxLength, preserveNewlines: false });
}

function cleanTextOrList(value, maxLength = 1000) {
    if (Array.isArray(value)) return value.map((item) => cleanText(item, maxLength)).filter(Boolean);
    return cleanText(value, maxLength);
}

function isPresent(value) {
    return value !== undefined && value !== null && value !== ''
        && (!Array.isArray(value) || value.length > 0);
}

function isMeaningful(value) {
    return isPresent(value) && !(typeof value === 'string' && value.trim().toLowerCase() === 'none');
}

function firstMeaningfulText(values, maxLength) {
    for (const value of values) {
        const clean = cleanText(value, maxLength);
        if (isMeaningful(clean)) return clean;
    }
    return '';
}

function actorAlias(value) {
    const clean = cleanText(value, 200);
    return clean ? clean.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ') : '';
}

function buildActorAliases(state) {
    const candidates = new Map();
    for (const [id, actor] of Object.entries(state.actors)) {
        for (const value of [id, actor.name, actor.displayName]) {
            const alias = actorAlias(value);
            if (!alias) continue;
            if (!candidates.has(alias)) candidates.set(alias, new Set());
            candidates.get(alias).add(id);
        }
    }
    return new Map([...candidates]
        .filter(([, ids]) => ids.size === 1)
        .map(([alias, ids]) => [alias, [...ids][0]]));
}

function resolveActorId(value, aliases) {
    return aliases.get(actorAlias(value)) ?? '';
}

function compactWorld(scene) {
    const world = { environment: cleanText(scene.environment, 1200) || 'None' };
    const openBeat = cleanText(scene.openBeat, 1000);
    const timePressure = cleanText(scene.timePressure, 1000);
    const time = cleanText(scene.time, 100);
    if (isMeaningful(openBeat)) world.openBeat = openBeat;
    if (isMeaningful(timePressure)) world.timePressure = timePressure;
    if (time) world.time = time;
    return world;
}

function compactActor(actor, id, scene, spotlightIds) {
    const name = cleanText(actor.name ?? id, 200) || id;
    const frame = { id, name };
    const displayName = cleanText(actor.displayName, 200);
    if (displayName && displayName !== name) frame.displayName = displayName;

    // User autonomy: the local frame exposes only established placement,
    // enacted activity, body facts, and affiliations for the PC. NPC-only
    // cognition and agenda fields remain absent even after a legacy import.
    if (id === 'US') {
        const position = firstMeaningfulText([scene.positions?.[id], actor.position, actor.location, actor.at], 500);
        if (isMeaningful(position)) frame.position = position;
        const userState = {};
        const activity = firstMeaningfulText([actor.doing, actor.activity], 1000);
        if (isMeaningful(activity)) userState.activity = activity;
        for (const field of ['circle', 'body']) {
            const value = cleanTextOrList(actor[field], 1000);
            if (isMeaningful(value)) userState[field] = value;
        }
        if (Object.keys(userState).length) frame.state = userState;
        return frame;
    }

    // Scene positions are the authoritative local placement. Actor-level
    // position/location/at aliases are folded into the same single field.
    const position = firstMeaningfulText([scene.positions?.[id], actor.position, actor.location, actor.at], 500);
    if (isMeaningful(position)) frame.position = position;

    const state = {};
    const activity = firstMeaningfulText([actor.doing, actor.activity], 1000);
    const agenda = firstMeaningfulText([actor.agenda, actor.agendaGoal], 1000);
    if (isMeaningful(activity)) state.activity = activity;
    if (isMeaningful(agenda)) state.agenda = agenda;
    if (isMeaningful(actor.agendaGoal) && cleanText(actor.agendaGoal, 1000) !== agenda) state.agendaGoal = cleanText(actor.agendaGoal, 1000);
    for (const field of ACTOR_NUMBER_FIELDS) {
        if (typeof actor[field] === 'number' && Number.isFinite(actor[field])) state[field] = actor[field];
    }
    const vad = {};
    for (const [field, key] of [['valence', 'v'], ['arousal', 'a'], ['dominance', 'd']]) {
        if (typeof actor[field] === 'number' && Number.isFinite(actor[field])) vad[key] = actor[field];
    }
    if (Object.keys(vad).length) state.vad = vad;
    for (const field of ACTOR_TEXT_FIELDS) {
        const value = cleanTextOrList(actor[field], 1000);
        if (isMeaningful(value)) state[field] = value;
    }
    const actorSpotlight = cleanTextOrList(actor.spotlight, 300);
    if (isMeaningful(actorSpotlight)) state.spotlight = actorSpotlight;
    else if (spotlightIds.has(id)) state.spotlight = true;
    if (Object.keys(state).length) frame.state = state;
    return frame;
}

function compactThought(item) {
    if (typeof item === 'string') return { thoughts: cleanText(item, 2000) };
    if (!isPlainObject(item)) return { thoughts: cleanText(item, 2000) };
    const actor = cleanText(item.actor ?? item.name ?? item.subject ?? item.id, 200);
    const thoughts = cleanText(item.thoughts ?? item.text, 2000);
    return {
        ...(actor ? { actor } : {}),
        ...(thoughts ? { thoughts } : {}),
    };
}

function compactResidue(item, id = '') {
    if (typeof item === 'string') return { event: cleanText(item, 2000) };
    if (!isPlainObject(item)) return { event: cleanText(item, 2000) };
    const result = id ? { id } : {};
    const fields = [
        ['subject', item.subject ?? item.actor ?? item.name],
        ['event', item.event],
        ['meaning', item.meaning],
        ['aftereffect', item.aftereffect],
        ['cue', item.cue],
    ];
    for (const [field, value] of fields) {
        const clean = cleanText(value, 2000);
        if (clean) result[field] = clean;
    }
    return result;
}

function selectedIds(state, aliases, requested) {
    if (!Array.isArray(requested)) return Object.keys(state.actors).sort();
    return [...new Set(requested.map((value) => resolveActorId(value, aliases)).filter(Boolean))].sort();
}

function compactRelation(relation) {
    return {
        a: cleanText(relation.a, 100),
        b: cleanText(relation.b, 100),
        bond: relation.bond,
        sparks: relation.sparks,
        grudge: relation.grudge,
    };
}

/**
 * Build the future prompt-facing Local Frame without changing canonical state.
 * This module is deliberately not wired into the active Shadow prompt yet.
 */
export function projectUnifiedLocalFrame(input, options = {}) {
    const state = migrateState(input);
    const aliases = buildActorAliases(state);
    const ids = selectedIds(state, aliases, options.selectedActorIds);
    const included = new Set(ids);
    const spotlightIds = new Set((state.scene.spotlight ?? []).map((value) => resolveActorId(value, aliases)).filter(Boolean));
    const actors = ids.map((id) => compactActor(state.actors[id], id, state.scene, spotlightIds));
    const actorFrames = new Map(actors.map((actor) => [actor.id, actor]));
    const unassignedThoughts = [];
    const unassignedResidue = [];

    for (const raw of state.thoughts) {
        const thought = compactThought(raw);
        const id = resolveActorId(thought.actor, aliases);
        if (id && actorFrames.has(id) && thought.thoughts) {
            const frame = actorFrames.get(id);
            if (!frame.thoughts) frame.thoughts = [];
            frame.thoughts.push(thought.thoughts);
        } else if (options.includeUnassigned !== false && Object.keys(thought).length) unassignedThoughts.push(thought);
    }
    for (const entry of residueEntries(state.residue)) {
        const residue = compactResidue(entry.record, entry.id);
        const id = resolveActorId(residue.subject, aliases);
        if (id && actorFrames.has(id)) {
            const frame = actorFrames.get(id);
            if (!frame.residue) frame.residue = [];
            const { subject: _subject, ...attached } = residue;
            if (Object.keys(attached).length) frame.residue.push(attached);
        } else if (options.includeUnassigned !== false && Object.keys(residue).length) unassignedResidue.push(residue);
    }

    const relations = Object.entries(state.relations.pairs ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, relation]) => relation)
        .filter((relation) => included.has(relation.a) || included.has(relation.b))
        .map(compactRelation);
    return {
        version: 1,
        meta: { ct: state.ct, head: cleanText(state.head, 200) },
        world: compactWorld(state.scene),
        actors,
        relations,
        ...(unassignedThoughts.length ? { unassignedThoughts } : {}),
        ...(unassignedResidue.length ? { unassignedResidue } : {}),
    };
}

/** Deterministic line transport for the future Native prompt. */
export function formatUnifiedLocalFrame(frame) {
    const source = frame ?? {};
    const lines = [
        'ST_LOCAL_FRAME v1',
        `META ${stableStringify(source.meta ?? {})}`,
        `WORLD ${stableStringify(source.world ?? {})}`,
    ];
    for (const actor of source.actors ?? []) lines.push(`ACTOR_FRAME ${stableStringify(actor)}`);
    for (const relation of source.relations ?? []) lines.push(`RELATION ${stableStringify(relation)}`);
    for (const thought of source.unassignedThoughts ?? []) lines.push(`UNASSIGNED_THOUGHT ${stableStringify(thought)}`);
    for (const residue of source.unassignedResidue ?? []) lines.push(`UNASSIGNED_RESIDUE ${stableStringify(residue)}`);
    lines.push('END_ST_LOCAL_FRAME');
    return lines.join('\n').replace(/\u2028|\u2029/g, ' ');
}

export const buildUnifiedLocalFrame = (state, options = {}) => formatUnifiedLocalFrame(projectUnifiedLocalFrame(state, options));
