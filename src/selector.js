import { isValidActorId } from './identity.js';
import { sanitizePlainText } from './util.js';
import { shadowHandshake } from './shadow.js';

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionMatches(text, label) {
    const source = String(text ?? '');
    const target = String(label ?? '').trim();
    if (!target) return false;
    try {
        return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(target)}($|[^\\p{L}\\p{N}_])`, 'iu').test(source);
    } catch {
        const lower = source.toLowerCase();
        const needle = target.toLowerCase();
        let offset = lower.indexOf(needle);
        while (offset >= 0) {
            const before = lower[offset - 1] ?? '';
            const after = lower[offset + needle.length] ?? '';
            if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) return true;
            offset = lower.indexOf(needle, offset + needle.length);
        }
        return false;
    }
}

function actorNames(actor, id) {
    return [id, actor?.name, actor?.displayName].filter((value) => typeof value === 'string' && value.trim());
}

function resolveActorId(state, value) {
    if (isValidActorId(value) && state.actors?.[value]) return value;
    const needle = String(value ?? '').trim().toLowerCase();
    return Object.entries(state.actors ?? {}).find(([id, actor]) => id.toLowerCase() === needle || String(actor?.name ?? '').toLowerCase() === needle || String(actor?.displayName ?? '').toLowerCase() === needle)?.[0] ?? '';
}

function sceneSpotlightIds(state) {
    const result = new Set();
    const values = Array.isArray(state.scene?.spotlight) ? state.scene.spotlight : (state.scene?.spotlight ? [state.scene.spotlight] : []);
    for (const value of values) {
        const id = resolveActorId(state, value);
        if (id) result.add(id);
    }
    return result;
}

function isOnScreenActor(state, id, actor, options) {
    const current = new Set((options.currentActorIds ?? options.onScreenActorIds ?? []).map((value) => resolveActorId(state, value)).filter(Boolean));
    if (current.has(id)) return true;
    if (state.scene?.positions && Object.prototype.hasOwnProperty.call(state.scene.positions, id)) return true;
    const actorPosition = actor?.position ?? actor?.at ?? actor?.location;
    if (!actorPosition) return false;
    const positions = Object.values(state.scene?.positions ?? {}).map((value) => String(value).toLowerCase());
    return positions.length > 0 && positions.includes(String(actorPosition).toLowerCase());
}

function compactActor(actor, id) {
    const result = { id, name: sanitizePlainText(actor?.name ?? id, { maxLength: 200, preserveNewlines: false }) || id };
    for (const field of ['displayName', 'at', 'location', 'position', 'doing', 'activity', 'agenda', 'agendaGoal', 'focus', 'aware', 'fibs', 'circle', 'body', 'spotlight']) {
        if (actor?.[field] !== undefined && actor?.[field] !== null && actor[field] !== '') result[field] = Array.isArray(actor[field]) ? actor[field].map((value) => sanitizePlainText(value, { maxLength: 300, preserveNewlines: false })) : sanitizePlainText(actor[field], { maxLength: 1000, preserveNewlines: false });
    }
    for (const field of ['valence', 'arousal', 'dominance', 'agendaStep', 'agendaMax']) if (typeof actor?.[field] === 'number' && Number.isFinite(actor[field])) result[field] = actor[field];
    return result;
}

function compactScene(scene = {}, selectedIds = new Set()) {
    const positions = {};
    for (const [id, position] of Object.entries(scene.positions ?? {})) if (!selectedIds.size || selectedIds.has(id)) positions[id] = sanitizePlainText(position, { maxLength: 500, preserveNewlines: false });
    return {
        spotlight: (Array.isArray(scene.spotlight) ? scene.spotlight : (scene.spotlight ? [scene.spotlight] : [])).map((value) => sanitizePlainText(value, { maxLength: 200, preserveNewlines: false })).filter(Boolean),
        openBeat: sanitizePlainText(scene.openBeat ?? 'None', { maxLength: 1000, preserveNewlines: false }) || 'None',
        timePressure: sanitizePlainText(scene.timePressure ?? 'None', { maxLength: 1000, preserveNewlines: false }) || 'None',
        environment: sanitizePlainText(scene.environment ?? 'None', { maxLength: 1200, preserveNewlines: false }) || 'None',
        positions,
        ...(scene.time ? { time: sanitizePlainText(scene.time, { maxLength: 100, preserveNewlines: false }) } : {}),
    };
}

function compactRelation(relation) {
    return {
        a: relation.a,
        b: relation.b,
        bond: relation.bond,
        sparks: relation.sparks,
        grudge: relation.grudge,
    };
}

/** Select hot actors/links without deleting or rewriting any cold state. */
export function selectHotState(state, options = {}) {
    const source = state ?? {};
    const selected = new Set();
    const text = options.userText ?? options.messageText ?? options.text ?? '';
    const explicit = options.mentionedActorIds ?? options.mentions ?? [];
    for (const value of explicit) { const id = resolveActorId(source, value); if (id) selected.add(id); }
    const spotlight = sceneSpotlightIds(source);
    spotlight.forEach((id) => selected.add(id));
    for (const [id, actor] of Object.entries(source.actors ?? {})) {
        if (actorNames(actor, id).some((label) => mentionMatches(text, label))) selected.add(id);
        if (isOnScreenActor(source, id, actor, options)) selected.add(id);
    }
    // The user is part of the local frame whenever it is represented in state.
    if (source.actors?.US) selected.add('US');
    const maxActors = Number.isInteger(options.maxActors) && options.maxActors > 0 ? options.maxActors : 24;
    const ordered = [...selected].sort((left, right) => {
        const leftScore = (spotlight.has(left) ? 4 : 0) + (left === 'US' ? 3 : 0) + (text && actorNames(source.actors[left], left).some((label) => mentionMatches(text, label)) ? 2 : 0);
        const rightScore = (spotlight.has(right) ? 4 : 0) + (right === 'US' ? 3 : 0) + (text && actorNames(source.actors[right], right).some((label) => mentionMatches(text, label)) ? 2 : 0);
        return rightScore - leftScore || left.localeCompare(right);
    }).slice(0, maxActors);
    const hotIds = new Set(ordered);
    const relations = Object.values(source.relations?.pairs ?? {}).filter((relation) => hotIds.has(relation.a) || hotIds.has(relation.b)).map(compactRelation);
    const relationKeys = new Set(Object.values(source.relations?.pairs ?? {}).filter((relation) => hotIds.has(relation.a) || hotIds.has(relation.b)).map((relation) => `${relation.a}|${relation.b}`));
    const actors = {};
    for (const id of ordered) if (source.actors[id]) actors[id] = compactActor(source.actors[id], id);
    return {
        meta: { ct: Number.isInteger(source.ct) ? source.ct : 0, head: String(source.head ?? '') },
        scene: compactScene(source.scene, hotIds),
        actors,
        relations,
        selectedActorIds: ordered,
        selectedRelationKeys: [...relationKeys],
        coldActorIds: Object.keys(source.actors ?? {}).filter((id) => !hotIds.has(id)),
        coldRelationKeys: Object.keys(source.relations?.pairs ?? {}).filter((key) => !relationKeys.has(key)),
    };
}

function compactJson(value) {
    return JSON.stringify(value).replace(/\u2028|\u2029/g, ' ');
}

export function formatHotStatePack(selection) {
    const lines = ['ST_STATE_PACK v2', `META ${compactJson(selection.meta)}`, `SCENE ${compactJson(selection.scene)}`];
    for (const actor of Object.values(selection.actors ?? {})) lines.push(`ACTOR ${compactJson(actor)}`);
    for (const relation of selection.relations ?? []) lines.push(`RELATION ${compactJson(relation)}`);
    lines.push('END_ST_STATE_PACK');
    return lines.join('\n');
}

export function buildProtocolPrompt(state, options = {}) {
    const selection = selectHotState(state, options);
    const mode = String(options.mode ?? 'SHADOW').trim().toUpperCase();
    if (mode !== 'SHADOW') return { text: shadowHandshake(state, { mode }), selection, mode };
    const protocol = [
        shadowHandshake(state, { mode }),
        'ST-STATE SHADOW TRANSACTION PROTOCOL v1',
        'Write ordinary prose first. Include an <internal_states> block with the next Turn header, then append exactly one hidden HTML comment with the line-based semantic patch.',
        'The <internal_states> block is authoritative for this turn. Include NPC STATE, BONDS, and SCENE & WORLD on every NORMAL turn; include any other legacy section that changed. Omitted sections and omitted cold actor/relation/position rows are carried forward unchanged. Present rows are authoritative; an explicit - None clears its section. ST_PATCH is an evaluation candidate only; it is never authoritative and never overwrites the canonical state.',
        'Patch transport is line-based, never JSON. Headers: V2, base=<current head>, mode=NORMAL, tx=<short stable turn identity>. Do not use braces, commas, JSON quoting, markdown fences, or an END line.',
        'NORMAL is the only state-bearing route. OOC and FLASH emit prose or handoff only: no legacy block and no ST_PATCH. If <flash_handoff .../> is present, FLASH wins.',
        'Allowed data lines only: actor.set|ID|field|value ; actor.create|ID|field|value ; scene.set|field|value ; scene.position|ID|value ; relation.set|A|B|bond|value ; relation.set|A|B|sparks|value ; relation.set|A|B|grudge|value. The value is the entire remainder of its one line and needs no quoting or escaping. Emit only fields changed this turn; never restate whole records.',
        'For every emitted data line, copy the value character-for-character from the corresponding field in the complete <internal_states> block you just wrote; never summarize or paraphrase it. The only exception is VAD, which must be numerically clamped to the patch range below.',
        'Patch VAD contract: valence, arousal, and dominance must each be finite numbers clamped to -2..2, even if legacy prose/state used a wider value. Copy actor IDs exactly from ST_STATE_PACK; never derive, rename, or replace them.',
        'Relationship ranges: bond is an integer from -5..20; sparks and grudge are integers from 0..100. Copy both actor IDs and values from the matching RELATION row. Do not emit arbitrary paths, unknown fields, profiles, or other mechanics reducers. Always emit both the required internal-state HTML block and ST_PATCH for NORMAL.',
        'Ordinary RP always uses NORMAL, even with no data lines; ct still advances. Use OOC only for an out-of-character answer and FLASH only when the router chooses FLASH. Never invent values. Put ST_PATCH outside and after <!-- GFX_END -->.',
        `<!--ST_PATCH\nV2\nbase=${selection.meta.head}\nmode=NORMAL\ntx=turn-${selection.meta.ct + 1}\n-->`,
        formatHotStatePack(selection),
    ];
    return { text: protocol.join('\n'), selection, mode };
}

export const buildHotStatePack = (state, options = {}) => formatHotStatePack(selectHotState(state, options));

