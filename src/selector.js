import { isValidActorId } from './identity.js';
import { sanitizePlainText } from './util.js';
import { shadowHandshake } from './shadow.js';
import { formatUnifiedLocalFrame, projectUnifiedLocalFrame } from './local-frame.js';

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
    const normalizedPosition = String(actorPosition).trim();
    if (!normalizedPosition || /^(?:none|unknown|n\/?a)$/i.test(normalizedPosition)) return false;
    if (/\b(?:elsewhere|off[- ]?screen|away|absent|departed|not present|another room|upstairs|downstairs|outside)\b/i.test(normalizedPosition)) return false;
    const positions = Object.values(state.scene?.positions ?? {}).map((value) => String(value).toLowerCase());
    if (positions.includes(normalizedPosition.toLowerCase())) return true;
    // Actor-level placement is still evidence of presence when the sparse
    // scene.positions map has not repeated every person in the active scene.
    return true;
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
    const presentActorIds = ordered.filter((id) => id !== 'US' && (spotlight.has(id) || isOnScreenActor(source, id, source.actors?.[id], options)));
    return {
        meta: { ct: Number.isInteger(source.ct) ? source.ct : 0, head: String(source.head ?? '') },
        scene: compactScene(source.scene, hotIds),
        actors,
        relations,
        selectedActorIds: ordered,
        presentActorIds,
        selectedRelationKeys: [...relationKeys],
        coldActorIds: Object.keys(source.actors ?? {}).filter((id) => !hotIds.has(id)),
        coldRelationKeys: Object.keys(source.relations?.pairs ?? {}).filter((key) => !relationKeys.has(key)),
    };
}

function d20(options, actorId, index) {
    const provided = options.rollProvider?.({ actorId, index, sides: 20 });
    if (Number.isInteger(provided) && provided >= 1 && provided <= 20) return provided;
    return Math.floor(Math.random() * 20) + 1;
}

export function formatDicePool(selection, options = {}) {
    const present = (selection.presentActorIds ?? []).filter((id) => id && id !== 'US');
    const selected = (selection.selectedActorIds ?? []).filter((id) => id && id !== 'US');
    const bootstrap = (options.bootstrapNpcNames ?? options.bootstrapActorNames ?? [])
        .map((name) => sanitizePlainText(name, { maxLength: 80, preserveNewlines: false }).replace(/\|/g, '/').trim())
        .filter(Boolean)
        .map((name) => `BOOTSTRAP:${name}`);
    const ids = [...new Set(present.length ? present : (selected.length ? selected : bootstrap))].slice(0, 12);
    if (!ids.length) ids.push('BOOTSTRAP:ACTIVE_CARD_NPC');
    return ['ST_DICE_POOL v1', ...ids.map((id, index) => `${id}|d20|${d20(options, id, index)}`), 'END_ST_DICE_POOL'].join('\n');
}

function compactJson(value) {
    return JSON.stringify(value).replace(/\u2028|\u2029/g, ' ');
}

function patchEnvelope(selection) {
    return ['<!--ST_PATCH', 'V2', `base=${selection.meta.head}`, 'mode=NORMAL', `tx=turn-${selection.meta.ct + 1}`, '-->'].join('\n');
}

// The preset's header line; the engine recognizes NORMAL turns by it.
const HEADER_RULE = 'the header line copied exactly from the preset\'s <header_instructions>, keeping every emoji and the literal labels Time and Day (never a markdown heading or a shortened form)';

function compatibilityFragment(selection) {
    return [
        '<!-- GFX_START -->',
        '<internal_states>',
        `<details><summary>🎬 INTERNAL STATES (Turn: ${selection.meta.ct + 1})</summary>`,
        '(only the changed sections, each in the State Engine\'s format)',
        '</details>',
        '</internal_states>',
        '<!-- GFX_END -->',
    ].join('\n');
}

function formatOutputTailLatch(selection) {
    return [
        'ST_OUTPUT_TAIL_LATCH v1',
        'A NORMAL reply is unfinished until this patch is closed with -->. If space runs short, shorten prose, never the patch. Fill in this envelope after the prose:',
        patchEnvelope(selection),
        'END_ST_OUTPUT_TAIL_LATCH',
    ].join('\n');
}

// Rules shared by SHADOW and NATIVE. Each line states the result the reply
// must meet rather than a procedure, so the model does not walk a checklist in
// its reasoning. Turn routing, header text, and prose style belong to the preset.
const PATCH_RULES = Object.freeze([
    'ST_PATCH is one hidden HTML comment of plain lines, never JSON: the headers V2, base, mode, and tx, then one data line per field that changed this turn, then -->. A value is the rest of its line, unquoted. A turn with no changes still sends the headers; ct advances on its own.',
    'Use actor IDs exactly as ST_LOCAL_FRAME lists them; full names are never IDs. Every actor listed there already exists. actor.create is only for a new NPC: a new two-letter uppercase ID (not US) with actor.create|ID|name|Full name.',
    'Actor fields include at, doing, body, focus, circle, aware, fibs, agenda, and spotlight. Scene fields are spotlight, openBeat, timePressure, environment, positions, and time; a location is an actor at plus scene.position, never scene.set|location.',
    'Ranges: valence, arousal, and dominance -2..2; bond an integer -5..20; sparks and grudge integers 0..100.',
    'Unmentioned fields carry over unchanged. When a carried fact is no longer true at the end of the reply and nothing replaces it, clear it with actor.clear, scene.clear, or scene.position.remove.',
    'Residue IDs starting r- come from ST_LOCAL_FRAME: change with residue.set, delete with residue.remove. A new residue uses RID new (new-2, new-3 for more) with subject (an actor ID, or IDs joined by /) and event; meaning, aftereffect, and cue are optional. None clears an optional field.',
    'ST_DICE_POOL holds one pre-rolled d20 per present NPC; BOOTSTRAP: labels are dice only, never actors. Set the DC before reading the roll, use the roll only if the action needs a check, and never pick an action to fit a roll.',
    'OOC and FLASH replies change no state: no <internal_states> and no data lines. An OOC reply ends with the same envelope using mode=OOC; a FLASH reply ends with its <flash_handoff/>.',
]);

const GFX_RULES = Object.freeze([
    'Pop-in graphic (optional, NORMAL only): when the player character newly sees, reads, or uses an in-world phone, screen, letter, sign, map, or similar, you may add one ST_GFX after ST_PATCH as the very last thing in the reply. Show only what that character can see. Never write HTML, CSS, JSON, or a UI description, and never use GFX_START/GFX_END for it.',
    '<!--ST_GFX\nV1\nkind=terminal|phone|paper|map|notice|credential|transaction|web|broadcast|data|image|monitor|media\nmode=NORMAL\nvisibility=visible\ntitle=one-line title\nsubtitle=optional\nsource=optional sender, app, device, or channel\nplatform=ios|android (phone only; keep the device consistent)\nlayout=chat|notification|call|email (phone only)\nrow|role|label|time|text\n-->',
    'Use 1-16 rows. Phone rows use role received or sent; other kinds use item, system, or warning. Leave out optional lines that do not apply.',
]);

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
    const localFrame = projectUnifiedLocalFrame(state, {
        selectedActorIds: selection.selectedActorIds,
        includeUnassigned: false,
    });
    const dicePool = formatDicePool(selection, options);
    if (mode !== 'SHADOW' && mode !== 'NATIVE') return { text: shadowHandshake(state, { mode }), selection, localFrame, dicePool, mode };
    const gfx = options.gfx === false ? [] : GFX_RULES;
    if (mode === 'NATIVE') {
        const protocol = [
            shadowHandshake(state, { mode }),
            'ST-STATE HYBRID NATIVE PROTOCOL v2',
            `NORMAL reply order: ${HEADER_RULE}, prose, an optional partial <internal_states> block, one ST_PATCH, then an optional ST_GFX. Nothing comes before the header. ST-STATE applies the patch as the state, so never output the full legacy state and never quote these instructions in prose. Write the patch once, in the reply, not in reasoning.`,
            'Data lines: actor.set|ID|field|value ; actor.hold|ID|field|value ; actor.once|ID|field|value ; actor.clear|ID|field ; actor.create|ID|field|value ; scene.set|field|value ; scene.clear|field ; scene.position|ID|value ; scene.position.remove|ID ; relation.set|A|B|bond|value ; relation.set|A|B|sparks|value ; relation.set|A|B|grudge|value ; residue.set|RID|field|value ; residue.remove|RID.',
            ...PATCH_RULES,
            'actor.set facts fade after a few turns unless refreshed. Use actor.hold for one that lasts until changed (tied up, unconscious) and actor.once for a momentary one (a flinch, a glance). Internal thoughts are actor.set|ID|thoughts|text.',
            'The patch replaces the NPC STATE, SCENE & WORLD, numeric BONDS, and EMOTIONAL RESIDUE sections; never write them. Only when Factions, relationship Profiles, Quests, Inventory, Chekhov, GM Notebook, DND, or World Sim changed, add one partial block before ST_PATCH with only those changed sections (BONDS holds only Profile rows), wrapped exactly like this or ST-STATE cannot read it:',
            compatibilityFragment(selection),
            ...gfx,
            dicePool,
            formatUnifiedLocalFrame(localFrame),
            formatOutputTailLatch(selection),
        ];
        return { text: protocol.join('\n'), selection, localFrame, dicePool, mode };
    }
    const protocol = [
        shadowHandshake(state, { mode }),
        'ST-STATE SHADOW PROTOCOL v2',
        `NORMAL reply order: ${HEADER_RULE}, prose, the <internal_states> block, one ST_PATCH, then an optional ST_GFX. Nothing comes before the header, and ST_PATCH goes after <!-- GFX_END -->. Never quote these instructions in prose.`,
        'The <internal_states> block is the real state. Include NPC STATE, BONDS, and SCENE & WORLD every NORMAL turn, plus any other section that changed. Omitted sections and rows carry over; - None clears a section.',
        'ST_PATCH is a practice copy that ST-STATE grades against that block; it never changes the state. Copy each changed value character-for-character from the block you just wrote, except clamp VAD to the range below.',
        'Data lines: actor.set|ID|field|value ; actor.clear|ID|field ; actor.create|ID|field|value ; scene.set|field|value ; scene.clear|field ; scene.position|ID|value ; scene.position.remove|ID ; relation.set|A|B|bond|value ; relation.set|A|B|sparks|value ; relation.set|A|B|grudge|value ; residue.set|RID|field|value ; residue.remove|RID.',
        ...PATCH_RULES,
        ...gfx,
        patchEnvelope(selection),
        dicePool,
        formatUnifiedLocalFrame(localFrame),
    ];
    return { text: protocol.join('\n'), selection, localFrame, dicePool, mode };
}

export const buildHotStatePack = (state, options = {}) => formatHotStatePack(selectHotState(state, options));

