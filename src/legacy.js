import { createEmptyState, migrateState, relationKey } from './schema.js';
import { makeStableActorId, isUserLabel, isValidActorId, normalizeActorId } from './identity.js';
import { deepClone, escapeHtmlText, hasOwn, isPlainObject, plainTextFromHtml, sanitizePlainText, splitPipeFields, stableHash } from './util.js';

const SECTION_NAMES = Object.freeze({
    npc: '👥 NPC STATE',
    factions: '🏳️ FACTIONS',
    bonds: '💚 BONDS',
    residue: '🧩 EMOTIONAL RESIDUE',
    quests: '📜 QUESTS',
    inventory: '🎒 INV & SKILLS',
    chekhov: "🔫 CHEKHOV'S GUN",
    thoughts: '🧠 INTERNAL THOUGHTS',
    notebook: "📓 GM'S NOTEBOOK",
    dnd: '🎲 DND TASK SIM',
    worldSim: '🌎 WORLD SIM',
    scene: '🌌 SCENE & WORLD',
});

export function extractLatestInternalStates(input) {
    const source = String(input ?? '');
    const expression = /<internal_states\b[^>]*>[\s\S]*?<\/internal_states\s*>/gi;
    const matches = [...source.matchAll(expression)];
    if (matches.length === 0) return { ok: false, raw: '', body: '', index: -1, reason: 'No complete <internal_states> block found' };
    const match = matches.at(-1);
    const raw = match[0];
    const before = source.slice(0, match.index ?? 0);
    const afterStart = (match.index ?? 0) + raw.length;
    const after = source.slice(afterStart);
    const startMarker = /<!--[\s]*GFX_START[\s]*-->/i.exec(before.slice(Math.max(0, before.length - 80)));
    const endMarker = /^[\s]*<!--[\s]*GFX_END[\s]*-->/i.exec(after);
    const wrappedStart = startMarker ? before.lastIndexOf(startMarker[0]) : -1;
    const wrappedRaw = wrappedStart >= 0 && endMarker ? source.slice(wrappedStart, afterStart + endMarker[0].length) : raw;
    const openEnd = raw.indexOf('>') + 1;
    const closeStart = raw.toLowerCase().lastIndexOf('</internal_states');
    return { ok: true, raw, wrappedRaw, wrapper: wrappedRaw !== raw ? 'GFX' : '', body: raw.slice(openEnd, closeStart), index: match.index ?? -1 };
}

/** Parse nested details without using innerHTML or trusting model markup. */
export function parseDetailsTree(input) {
    const source = String(input ?? '');
    const root = { summary: '', raw: source, content: source, children: [], start: 0, end: source.length };
    const stack = [root];
    const token = /<details\b[^>]*>|<\/details\s*>|<summary\b[^>]*>[\s\S]*?<\/summary\s*>/gi;
    let match;
    while ((match = token.exec(source))) {
        const text = match[0];
        if (/^<details\b/i.test(text)) {
            const node = { summary: '', raw: '', content: '', children: [], start: match.index, end: source.length, openEnd: token.lastIndex, contentStart: token.lastIndex };
            stack.at(-1).children.push(node);
            stack.push(node);
        } else if (/^<summary\b/i.test(text)) {
            const node = stack.at(-1);
            if (node && node !== root && !node.summary) {
                node.summary = sanitizePlainText(plainTextFromHtml(text.replace(/^<summary\b[^>]*>/i, '').replace(/<\/summary\s*>$/i, '')), { maxLength: 300, preserveNewlines: false });
                node.contentStart = token.lastIndex;
            }
        } else if (stack.length > 1) {
            const node = stack.pop();
            node.end = token.lastIndex;
            node.raw = source.slice(node.start, node.end);
            node.content = source.slice(node.contentStart, match.index);
        }
    }
    return root;
}

function findNode(nodes, pattern) {
    for (const node of nodes ?? []) {
        if (pattern.test(node.summary)) return node;
        const nested = findNode(node.children, pattern);
        if (nested) return nested;
    }
    return null;
}

function directSection(outer, pattern) {
    return (outer?.children ?? []).find((node) => pattern.test(node.summary)) ?? findNode(outer?.children, pattern);
}

function rowsFromHtml(content) {
    return plainTextFromHtml(content)
        .replace(/\u00a0/g, ' ')
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

function removeBullet(value) {
    return String(value ?? '').replace(/^\s*[-•*]\s*/, '').trim();
}

function parseLabelFields(line) {
    const parts = splitPipeFields(removeBullet(line));
    const first = parts.shift() ?? '';
    const fields = { _first: first };
    const firstMatch = first.match(/^\s*([^:=|]{1,40})\s*[:=]\s*(.*)$/);
    if (firstMatch) {
        fields._first = '';
        fields[sanitizePlainText(firstMatch[1], { maxLength: 40, preserveNewlines: false })] = firstMatch[2].trim();
    }
    for (const part of parts) {
        const match = part.match(/^\s*([^:=|]{1,40})\s*[:=]\s*(.*)$/);
        if (match) fields[sanitizePlainText(match[1], { maxLength: 40, preserveNewlines: false })] = match[2].trim();
    }
    return fields;
}

function parseValueOrNone(value) {
    const clean = sanitizePlainText(value, { maxLength: 4000 });
    return clean || 'None';
}

function parseNumber(value, fallback = 0) {
    const match = String(value ?? '').match(/[-+]?\d+(?:\.\d+)?/);
    if (!match) return fallback;
    const number = Number(match[0]);
    return Number.isFinite(number) ? number : fallback;
}

function parseActorRow(line) {
    const fields = parseLabelFields(line);
    const hasActorFields = ['At', 'Doing', 'Agenda', 'VAD', 'Focus', 'Aware', 'Fibs', 'Circle', 'Body'].some((key) => hasOwn(fields, key));
    if (!hasActorFields) return null;
    const idMatch = fields._first.match(/^\[([A-Z]{2})\]\s*/);
    const legacyId = idMatch?.[1] ? normalizeActorId(idMatch[1]) : '';
    let name = fields._first.replace(/^\[([A-Z]{2})\]\s*/, '').trim();
    name = name.replace(/^<b>|<\/b>$/gi, '').trim();
    if (!name || /^none$/i.test(name)) return null;
    const actor = { name: parseValueOrNone(name) };
    if (legacyId) actor.legacyId = legacyId;
    if (fields.At !== undefined) actor.at = parseValueOrNone(fields.At);
    if (fields.Doing !== undefined) actor.doing = parseValueOrNone(fields.Doing);
    if (fields.Agenda !== undefined) actor.agenda = parseValueOrNone(fields.Agenda);
    if (fields.VAD !== undefined) {
        const values = String(fields.VAD).match(/[-+]?\d+(?:\.\d+)?/g) ?? [];
        if (values.length > 0) actor.valence = Math.max(-2, Math.min(2, Number(values[0])));
        if (values.length > 1) actor.arousal = Math.max(-2, Math.min(2, Number(values[1])));
        if (values.length > 2) actor.dominance = Math.max(-2, Math.min(2, Number(values[2])));
    }
    for (const key of ['Focus', 'Aware', 'Fibs', 'Circle', 'Body']) if (fields[key] !== undefined) actor[key.toLowerCase()] = parseValueOrNone(fields[key]);
    return actor;
}

function actorIdForName(state, name, userName = '') {
    const normalized = sanitizePlainText(name, { maxLength: 200, preserveNewlines: false });
    const resolvedUserName = sanitizePlainText(userName, { maxLength: 200, preserveNewlines: false });
    if (isUserLabel(normalized) || (resolvedUserName && normalized.toLowerCase() === resolvedUserName.toLowerCase())) {
        if (!state.actors.US) state.actors.US = { id: 'US', name: resolvedUserName || '{{user}}' };
        return 'US';
    }
    // Old ENDGAME ledgers displayed internal IDs in BONDS rows. NPC STATE is
    // parsed first, so an existing two-letter label is an actor reference—not
    // the name of a new pseudo-actor.
    const referencedId = normalizeActorId(normalized);
    if (isValidActorId(referencedId) && hasOwn(state.actors, referencedId)) return referencedId;
    const mapped = Object.entries(state.opaque?.legacy?.actorIds ?? {}).find(([label, id]) => String(label).toLowerCase() === normalized.toLowerCase() && isValidActorId(id));
    if (mapped && (!state.actors[mapped[1]] || String(state.actors[mapped[1]].name ?? '').toLowerCase() === normalized.toLowerCase())) {
        if (!hasOwn(state.actors, mapped[1])) state.actors[mapped[1]] = { id: mapped[1], name: normalized };
        return mapped[1];
    }
    const existing = Object.entries(state.actors).find(([, actor]) => String(actor.name ?? '').toLowerCase() === normalized.toLowerCase());
    if (existing) return existing[0];
    const id = makeStableActorId(normalized, state.actors);
    if (!hasOwn(state.actors, id)) state.actors[id] = { id, name: normalized };
    return id;
}

function actorLabel(state, id) {
    if (id === 'US') return '{{user}}';
    return state.actors[id]?.name || id;
}

function parseAgenda(value) {
    const match = String(value ?? '').match(/^(.*?);\s*(\d+)\s*\/\s*(\d+)$/);
    return match ? { text: parseValueOrNone(match[1]), step: Number(match[2]), max: Number(match[3]) } : { text: parseValueOrNone(value), step: 0, max: 0 };
}

function parseRelationshipRows(state, content, diagnostics, userName = '') {
    for (const line of rowsFromHtml(content)) {
        const plain = removeBullet(line);
        if (/^(?:\[Only if [^\]]+\]\s*)?Profile\s+/i.test(plain)) continue;
        const match = plain.match(/^(.+?)\s*[↔⟷]\s*(.+?)\s*\|\s*BOND:\s*([+-]?\d+)\s*\|\s*SPARKS?:\s*(\d+)\s*\|\s*GRUDGE:\s*(\d+)\s*$/i);
        if (!match) {
            if (!/^none$/i.test(plain)) diagnostics.unparsed.push(line);
            continue;
        }
        const leftLabel = sanitizePlainText(match[1], { maxLength: 200, preserveNewlines: false });
        const rightLabel = sanitizePlainText(match[2], { maxLength: 200, preserveNewlines: false });
        const left = actorIdForName(state, leftLabel, userName);
        const right = actorIdForName(state, rightLabel, userName);
        if (left === right) { diagnostics.unparsed.push(line); continue; }
        const key = relationKey(left, right);
        state.relations.pairs[key] = {
            a: left,
            b: right,
            labelA: leftLabel,
            labelB: rightLabel,
            bond: Math.max(-5, Math.min(20, Number(match[3]))),
            sparks: Math.max(0, Math.min(100, Number(match[4]))),
            grudge: Math.max(0, Math.min(100, Number(match[5]))),
        };
    }
}

function parseProfileRows(state, content, diagnostics, userName = '') {
    for (const line of rowsFromHtml(content)) {
        const plain = removeBullet(line);
        const match = plain.match(/^(?:\[Only if [^\]]+\]\s*)?Profile\s+(.+?)\s*→\s*(.+?)\s*:\s*Type\s*=\s*([^|]+?)\s*\|\s*Route\s*=\s*([^|]+?)\s*\|\s*Trust\s*=\s*([^|]+?)\s*\|\s*Attraction\s*=\s*([^|]+?)\s*\|\s*Expect\s*=\s*([^|]+?)\s*\|\s*Public\/Private\s*=\s*([^\/|]+?)\s*\/\s*([^|]+?)\s*\|\s*Jealousy\s*=\s*([^|]+?)\s*\|\s*Boundary\s*=\s*([^|]+?)\s*\|\s*Anchors\s*=\s*(.*)$/i);
        if (!match) {
            if (!/^none$/i.test(plain) && !/BOND:/i.test(plain)) diagnostics.unparsed.push(line);
            continue;
        }
        const fromLabel = sanitizePlainText(match[1], { maxLength: 200, preserveNewlines: false });
        const toLabel = sanitizePlainText(match[2], { maxLength: 200, preserveNewlines: false });
        const from = actorIdForName(state, fromLabel, userName);
        const to = actorIdForName(state, toLabel, userName);
        const profile = {
            from,
            to,
            type: parseValueOrNone(match[3]),
            route: parseValueOrNone(match[4]),
            trust: parseValueOrNone(match[5]),
            attraction: parseValueOrNone(match[6]),
            expect: parseValueOrNone(match[7]),
            public: parseValueOrNone(match[8]),
            private: parseValueOrNone(match[9]),
            jealousy: parseValueOrNone(match[10]),
            boundary: parseValueOrNone(match[11]),
            anchors: sanitizePlainText(match[12], { maxLength: 800 }),
        };
        state.relations.profiles[`${from}->${to}`] = profile;
        const key = relationKey(from, to);
        if (!state.relations.pairs[key]) state.relations.pairs[key] = { a: from, b: to, labelA: fromLabel, labelB: toLabel, bond: 0, sparks: 0, grudge: 0 };
        if (!state.relations.pairs[key].profile) state.relations.pairs[key].profile = {};
        state.relations.pairs[key].profile[`${from}->${to}`] = profile;
    }
}

function parseActorSection(state, section, diagnostics, userName = '') {
    for (const line of rowsFromHtml(section?.content ?? '')) {
        const actor = parseActorRow(line);
        if (!actor) {
            if (!/^none$/i.test(removeBullet(line))) diagnostics.unparsed.push(line);
            continue;
        }
        const hintedId = normalizeActorId(actor.legacyId);
        const existingHint = hintedId ? state.actors[hintedId] : null;
        const hintAvailable = isValidActorId(hintedId)
            && (hintedId === 'US' ? isUserLabel(actor.name) : (!existingHint || String(existingHint.name ?? '').toLowerCase() === actor.name.toLowerCase()));
        const id = hintAvailable ? hintedId : actorIdForName(state, actor.name, userName);
        if (isValidActorId(id) && actor.name) state.opaque.legacy.actorIds[actor.name] = id;
        const existing = state.actors[id] ?? { id, name: actor.name };
        state.actors[id] = { ...existing, ...actor, id };
        delete state.actors[id].legacyId;
        if (actor.agenda) {
            const parsed = parseAgenda(actor.agenda);
            state.actors[id].agenda = parsed.text;
            if (parsed.max > 0) { state.actors[id].agendaStep = parsed.step; state.actors[id].agendaMax = parsed.max; }
        }
    }
}

function parseFactionSection(state, section, diagnostics) {
    for (const line of rowsFromHtml(section?.content ?? '')) {
        const fields = parseLabelFields(line);
        if (!hasOwn(fields, 'Goal') && !hasOwn(fields, 'Intel')) { if (!/^none$/i.test(removeBullet(line))) diagnostics.unparsed.push(line); continue; }
        const name = parseValueOrNone(fields._first);
        if (name === 'None') continue;
        const key = name;
        state.factions[key] = { name, goal: parseValueOrNone(fields.Goal), intel: parseValueOrNone(fields.Intel), fibs: parseValueOrNone(fields.Fibs), state: parseValueOrNone(fields.State), conflict: parseValueOrNone(fields.Conflict), relations: parseValueOrNone(fields.Relations) };
    }
}

function parseResidueSection(state, section, diagnostics) {
    for (const line of rowsFromHtml(section?.content ?? '')) {
        const fields = parseLabelFields(line);
        if (!hasOwn(fields, 'Event')) { if (!/^none$/i.test(removeBullet(line))) diagnostics.unparsed.push(line); continue; }
        state.residue.push({ subject: parseValueOrNone(fields._first), event: parseValueOrNone(fields.Event), meaning: parseValueOrNone(fields.Meaning), aftereffect: parseValueOrNone(fields.Aftereffect), cue: parseValueOrNone(fields.Cue) });
    }
}

function parseQuestSection(state, section, diagnostics) {
    for (const line of rowsFromHtml(section?.content ?? '')) {
        const fields = parseLabelFields(line);
        if (!hasOwn(fields, 'Objective')) { if (!/^none$/i.test(removeBullet(line))) diagnostics.unparsed.push(line); continue; }
        state.quests.push({ title: parseValueOrNone(fields._first), state: parseValueOrNone(fields.State), objective: parseValueOrNone(fields.Objective), progress: parseValueOrNone(fields.Progress), reward: parseValueOrNone(fields.Reward), lockOwner: parseValueOrNone(fields['Lock/Owner']) });
    }
}

function parseInventorySection(state, section, diagnostics) {
    const lines = rowsFromHtml(section?.content ?? '');
    for (const line of lines) {
        const fields = parseLabelFields(line);
        if (hasOwn(fields, 'Inv')) state.inventory.items = parseValueOrNone(fields.Inv) === 'None' ? [] : [parseValueOrNone(fields.Inv)];
        if (hasOwn(fields, 'Titles/Skills')) state.inventory.titlesSkills = parseValueOrNone(fields['Titles/Skills']) === 'None' ? [] : [parseValueOrNone(fields['Titles/Skills'])];
        if (hasOwn(fields, 'Status')) state.inventory.status = parseValueOrNone(fields.Status) === 'None' ? [] : [parseValueOrNone(fields.Status)];
        if (hasOwn(fields, 'Mods')) state.inventory.modifiers = parseValueOrNone(fields.Mods) === 'None' ? [] : [parseValueOrNone(fields.Mods)];
    }
    if (lines.length && !lines.some((line) => /Inv:|Titles\/Skills:|Status:|Mods:/i.test(line))) diagnostics.unparsed.push(...lines);
}

function parseChekhovSection(state, section, diagnostics) {
    for (const line of rowsFromHtml(section?.content ?? '')) {
        const fields = parseLabelFields(line);
        if (!hasOwn(fields, 'Active')) { if (!/^none$/i.test(removeBullet(line))) diagnostics.unparsed.push(line); continue; }
        const parseList = (value) => parseValueOrNone(value) === 'None' ? [] : [parseValueOrNone(value)];
        state.chekhov = { active: parseList(fields.Active), locked: parseList(fields.Locked), fired: parseList(fields.Fired) };
    }
}

function parseThoughtSection(state, section, diagnostics) {
    for (const line of rowsFromHtml(section?.content ?? '')) {
        const fields = parseLabelFields(line);
        if (!hasOwn(fields, 'Internal Thoughts')) { if (!/^none$/i.test(removeBullet(line))) diagnostics.unparsed.push(line); continue; }
        state.thoughts.push({ actor: parseValueOrNone(fields._first), thoughts: parseValueOrNone(fields['Internal Thoughts']) });
    }
}

function parseNotebookSection(state, section, diagnostics) {
    for (const line of rowsFromHtml(section?.content ?? '')) {
        const plain = removeBullet(line);
        if (/^\[[RTD]\]/i.test(plain)) state.notebook.push(sanitizePlainText(plain, { maxLength: 2000 }));
        else if (!/^none$/i.test(plain)) diagnostics.unparsed.push(line);
    }
}

function parseDndSection(state, section, diagnostics) {
    const lines = rowsFromHtml(section?.content ?? '');
    if (lines.length === 0 || lines.every((line) => /^none$/i.test(removeBullet(line)))) return;
    const output = {};
    for (const line of lines) {
        const fields = parseLabelFields(line);
        for (const key of ['Task', 'Locked DC', 'User Roll', 'NPC Roll', 'Outcome']) if (hasOwn(fields, key)) output[key] = parseValueOrNone(fields[key]);
    }
    if (Object.keys(output).length) state.lastDnd = output;
    else diagnostics.unparsed.push(...lines);
}

function parseSceneSection(state, section, diagnostics, userName = '') {
    const lines = rowsFromHtml(section?.content ?? '');
    for (const line of lines) {
        const fields = parseLabelFields(line);
        if (hasOwn(fields, 'Spotlight')) state.scene.spotlight = parseValueOrNone(fields.Spotlight) === 'None' ? [] : [parseValueOrNone(fields.Spotlight)];
        if (hasOwn(fields, 'Open Beat')) state.scene.openBeat = parseValueOrNone(fields['Open Beat']);
        if (hasOwn(fields, 'Time Pressure')) state.scene.timePressure = parseValueOrNone(fields['Time Pressure']);
        if (hasOwn(fields, 'Env')) state.scene.environment = parseValueOrNone(fields.Env);
        if (hasOwn(fields, 'Positions')) state.scene.positionsRaw = parseValueOrNone(fields.Positions);
    }
    if (state.scene.positionsRaw) {
        const pairs = state.scene.positionsRaw.split(/[,;]+/);
        for (const pair of pairs) {
            const match = pair.match(/^\s*(.+?)\s*[:=]\s*(.+)$/);
            if (match) {
                const id = actorIdForName(state, match[1], userName);
                state.scene.positions[id] = parseValueOrNone(match[2]);
                continue;
            }
            // Older presets often wrote "Dex center floor" instead of
            // "Dex: center floor". Resolve only an already-known actor label;
            // never manufacture an actor from arbitrary position prose.
            const source = sanitizePlainText(pair, { maxLength: 2000, preserveNewlines: false }).trim();
            const labels = Object.entries(state.actors).flatMap(([id, actor]) => [
                { id, label: id },
                { id, label: actor?.name },
                { id, label: actor?.displayName },
                ...(id === 'US' ? [{ id, label: userName }, { id, label: '{{user}}' }, { id, label: 'User' }] : []),
            ]).filter((entry) => entry.label).sort((left, right) => String(right.label).length - String(left.label).length);
            const known = labels.find(({ label }) => source.toLowerCase().startsWith(`${String(label).trim().toLowerCase()} `));
            if (!known) continue;
            const position = source.slice(String(known.label).trim().length).trim().replace(/^[-–—:=>]+\s*/, '');
            if (position) state.scene.positions[known.id] = parseValueOrNone(position);
        }
        delete state.scene.positionsRaw;
    }
    if (lines.length && !lines.some((line) => /Spotlight:|Open Beat:|Env:|Positions:/i.test(line))) diagnostics.unparsed.push(...lines);
}

function mergeOpaqueRaw(state, sectionName, lines) {
    if (!lines?.length) return;
    state.opaque.legacy.unparsed[sectionName] = [...(state.opaque.legacy.unparsed[sectionName] ?? []), ...lines];
}

/** Parse one complete source-preset internal state block into the v2 schema. */
export function importLegacyState(input, options = {}) {
    const block = extractLatestInternalStates(input);
    if (!block.ok) return { ok: false, state: migrateState(options.baseState), diagnostics: [block.reason], block };
    // A complete legacy block is authoritative. Start with a fresh document so
    // a missing/empty section cannot accidentally retain stale values from a
    // previous chat state; actor IDs remain deterministic from their labels.
    const state = createEmptyState({ now: options.now });
    state.opaque.legacy.internalStatesRaw = block.wrappedRaw || block.raw;
    state.opaque.legacy.wrapper = block.wrapper || '';
    const actorIdComment = block.raw.match(/<!--[\s]*ST_ACTOR_IDS\s+({[\s\S]*?})\s*-->/i);
    if (actorIdComment) {
        try {
            const map = JSON.parse(actorIdComment[1]);
            if (isPlainObject(map)) for (const [label, id] of Object.entries(map)) if (isValidActorId(id)) state.opaque.legacy.actorIds[sanitizePlainText(label, { maxLength: 200, preserveNewlines: false })] = id;
        } catch { /* opaque comment is retained even if its optional map is malformed */ }
    }
    const tree = parseDetailsTree(block.body);
    const outer = findNode(tree.children, /INTERNAL STATES/i) ?? { children: tree.children, content: block.body };
    const summary = outer.summary || '';
    const turn = summary.match(/Turn\s*:\s*\[?\s*(\d+)\s*\]?/i);
    if (turn) { state.ct = Number(turn[1]); state.meta.ct = state.ct; }
    state.head = `legacy-${stableHash(block.raw)}`;
    state.meta.head = state.head;
    state.meta.updatedAt = Number.isFinite(options.now) ? options.now : Date.now();
    const diagnostics = [];
    const known = new Set();
    const mark = (pattern) => { const node = directSection(outer, pattern); if (node) known.add(node); return node; };

    const npcDiagnostics = { unparsed: [] }; const npc = mark(/NPC\s+STATE/i); parseActorSection(state, npc, npcDiagnostics, options.userName); mergeOpaqueRaw(state, 'NPC STATE', npcDiagnostics.unparsed);
    const factionDiagnostics = { unparsed: [] }; const factions = mark(/FACTIONS/i); parseFactionSection(state, factions, factionDiagnostics); mergeOpaqueRaw(state, 'FACTIONS', factionDiagnostics.unparsed);
    const bondsDiagnostics = { unparsed: [] }; const bonds = mark(/BONDS|BOND\s+TRACKER/i); if (bonds) { parseRelationshipRows(state, bonds.content, bondsDiagnostics, options.userName); parseProfileRows(state, bonds.content, bondsDiagnostics, options.userName); } mergeOpaqueRaw(state, 'BONDS', bondsDiagnostics.unparsed);
    const residueDiagnostics = { unparsed: [] }; const residue = mark(/EMOTIONAL\s+RESIDUE/i); parseResidueSection(state, residue, residueDiagnostics); mergeOpaqueRaw(state, 'EMOTIONAL RESIDUE', residueDiagnostics.unparsed);
    const questDiagnostics = { unparsed: [] }; const quests = mark(/QUESTS/i); parseQuestSection(state, quests, questDiagnostics); mergeOpaqueRaw(state, 'QUESTS', questDiagnostics.unparsed);
    const inventoryDiagnostics = { unparsed: [] }; const inventory = mark(/INV\s*&\s*SKILLS|INVENTORY\s*&\s*STATUS/i); parseInventorySection(state, inventory, inventoryDiagnostics); mergeOpaqueRaw(state, 'INV & SKILLS', inventoryDiagnostics.unparsed);
    const chekhovDiagnostics = { unparsed: [] }; const chekhov = mark(/CHEKHOV/i); parseChekhovSection(state, chekhov, chekhovDiagnostics); mergeOpaqueRaw(state, "CHEKHOV'S GUN", chekhovDiagnostics.unparsed);
    const thoughtDiagnostics = { unparsed: [] }; const thoughts = mark(/INTERNAL\s+THOUGHTS/i); parseThoughtSection(state, thoughts, thoughtDiagnostics); mergeOpaqueRaw(state, 'INTERNAL THOUGHTS', thoughtDiagnostics.unparsed);
    const notebookDiagnostics = { unparsed: [] }; const notebook = mark(/GM'?S?\s+NOTEBOOK/i); parseNotebookSection(state, notebook, notebookDiagnostics); mergeOpaqueRaw(state, "GM'S NOTEBOOK", notebookDiagnostics.unparsed);
    const dndDiagnostics = { unparsed: [] }; const dnd = mark(/DND\s+TASK\s+SIM/i); parseDndSection(state, dnd, dndDiagnostics); mergeOpaqueRaw(state, 'DND TASK SIM', dndDiagnostics.unparsed);
    const sceneDiagnostics = { unparsed: [] }; const scene = mark(/SCENE\s*&\s*WORLD/i); parseSceneSection(state, scene, sceneDiagnostics, options.userName); mergeOpaqueRaw(state, 'SCENE & WORLD', sceneDiagnostics.unparsed);
    const worldSim = mark(/WORLD\s+SIM/i);
    if (worldSim) {
        state.worldSim = { raw: worldSim.raw, data: null };
        state.opaque.legacy.worldSimRaw = worldSim.raw;
    } else if (options.baseState) {
        const previous = migrateState(options.baseState, { now: options.now });
        state.worldSim = deepClone(previous.worldSim);
        state.opaque.legacy.worldSimRaw = previous.opaque?.legacy?.worldSimRaw ?? '';
    }
    if (options.requireComplete) {
        const required = [
            ['turn header', turn], ['NPC STATE', npc], ['FACTIONS', factions], ['BONDS', bonds],
            ['EMOTIONAL RESIDUE', residue], ['QUESTS', quests], ['INV & SKILLS', inventory],
            ["CHEKHOV'S GUN", chekhov], ['INTERNAL THOUGHTS', thoughts], ["GM'S NOTEBOOK", notebook],
            ['DND TASK SIM', dnd], ['SCENE & WORLD', scene],
        ];
        const missingSections = required.filter(([, value]) => !value).map(([name]) => name);
        if (missingSections.length) {
            const reason = `Incomplete <internal_states> block; missing ${missingSections.join(', ')}`;
            return { ok: false, state: migrateState(options.baseState), diagnostics: [reason], block, missingSections };
        }
    }
    const siblingSections = tree.children.includes(outer) ? tree.children.filter((node) => node !== outer) : [];
    for (const node of [...(outer.children ?? []), ...siblingSections]) {
        if (known.has(node) || /INTERNAL\s+STATES/i.test(node.summary) || /WORLD\s+SIM/i.test(node.summary)) continue;
        if (/OPAQUE\s+LEGACY/i.test(node.summary)) {
            for (const nested of node.children ?? []) {
                const name = nested.summary || `unnamed-${Object.keys(state.opaque.legacy.sections).length + 1}`;
                state.opaque.legacy.sections[name] = nested.raw;
            }
            const childRaw = (node.children ?? []).map((child) => child.raw).join('\n');
            const loose = rowsFromHtml(node.content.replace(childRaw, '')).filter((line) => !/^opaque\s+/i.test(line));
            if (loose.length) mergeOpaqueRaw(state, 'OPAQUE LEGACY DATA', loose);
            continue;
        }
        const name = node.summary || `unnamed-${Object.keys(state.opaque.legacy.sections).length + 1}`;
        state.opaque.legacy.sections[name] = node.raw;
    }
    state.meta.mode = 'NORMAL';
    state.schemaVersion = 2;
    return { ok: true, complete: true, state, diagnostics, block, missingSections: [] };
}

export function parseLegacyState(input, options = {}) {
    return importLegacyState(input, options).state;
}

function valueOrNone(value) {
    if (Array.isArray(value)) return value.length ? escapeHtmlText(value.join(', ')) : 'None';
    if (value === null || value === undefined || value === '') return 'None';
    return escapeHtmlText(sanitizePlainText(value, { maxLength: 4000 }));
}

function actorAgenda(actor) {
    if (!actor.agenda) return 'None';
    if (Number.isInteger(actor.agendaStep) && Number.isInteger(actor.agendaMax) && actor.agendaMax > 0) return `${valueOrNone(actor.agenda)}; ${actor.agendaStep}/${actor.agendaMax}`;
    return valueOrNone(actor.agenda);
}

function exportActorLine(actor) {
    const vad = [actor.valence, actor.arousal, actor.dominance].every((value) => typeof value === 'number') ? `${actor.valence}/${actor.arousal}/${actor.dominance}` : 'None';
    return `- <b>${valueOrNone(actor.name || actor.id)}</b> | At: ${valueOrNone(actor.at ?? actor.location ?? actor.position)} | Doing: ${valueOrNone(actor.doing ?? actor.activity)} | Agenda: ${actorAgenda(actor)} | VAD: ${vad} | Focus: ${valueOrNone(actor.focus)} | Aware: ${valueOrNone(actor.aware)} | Fibs: ${valueOrNone(actor.fibs)} | Circle: ${valueOrNone(actor.circle)} | Body: ${valueOrNone(actor.body)}`;
}

function exportDetails(title, content, extra = '') {
    return `<details${extra}><summary>${title}</summary>\n${content || '- None'}\n</details>`;
}

function exportRelationRows(state) {
    const rows = [];
    for (const relation of Object.values(state.relations.pairs ?? {})) {
        // Canonical actor records own display names. Relation labels are import
        // hints and may still contain legacy two-letter IDs.
        const left = valueOrNone(actorLabel(state, relation.a) || relation.labelA);
        const right = valueOrNone(actorLabel(state, relation.b) || relation.labelB);
        rows.push(`- <b>${left}</b> ↔ <b>${right}</b> | BOND: ${relation.bond} | Sparks: ${relation.sparks} | Grudge: ${relation.grudge}`);
        const profileMap = { ...(relation.profile ?? {}) };
        for (const [profileKey, profile] of Object.entries(state.relations.profiles ?? {})) {
            if (profile?.from && profile?.to && relationKey(profile.from, profile.to) === relationKey(relation.a, relation.b)) profileMap[profileKey] = profile;
        }
        const profiles = Object.values(profileMap);
        for (const profile of profiles) {
            if (!profile || !profile.from || !profile.to) continue;
            const from = actorLabel(state, profile.from);
            const to = actorLabel(state, profile.to);
            rows.push(`- Profile ${valueOrNone(from)}→${valueOrNone(to)}: Type=${valueOrNone(profile.type)} | Route=${valueOrNone(profile.route)} | Trust=${valueOrNone(profile.trust)} | Attraction=${valueOrNone(profile.attraction)} | Expect=${valueOrNone(profile.expect)} | Public/Private=${valueOrNone(profile.public)}/${valueOrNone(profile.private)} | Jealousy=${valueOrNone(profile.jealousy)} | Boundary=${valueOrNone(profile.boundary)} | Anchors=${valueOrNone(profile.anchors)}`);
        }
    }
    return rows;
}

export function exportLegacyState(input, options = {}) {
    const state = migrateState(input);
    const lines = [];
    lines.push('<!-- GFX_START -->');
    lines.push('<internal_states>');
    const actorIds = Object.fromEntries(Object.values(state.actors).map((actor) => [sanitizePlainText(actor.name || actor.id, { maxLength: 200, preserveNewlines: false }), actor.id]).filter(([label, id]) => label && isValidActorId(id)));
    lines.push(`<!-- ST_ACTOR_IDS ${JSON.stringify(actorIds)} -->`);
    lines.push(exportDetails(`🎬 INTERNAL STATES (Turn: ${state.ct})`, [
        exportDetails(SECTION_NAMES.npc, Object.values(state.actors).map(exportActorLine).join('\n')),
        exportDetails(SECTION_NAMES.factions, Object.values(state.factions).map((faction) => `- <b>${valueOrNone(faction.name)}</b> | Goal: ${valueOrNone(faction.goal)} | Intel: ${valueOrNone(faction.intel)} | Fibs: ${valueOrNone(faction.fibs)} | State: ${valueOrNone(faction.state)} | Conflict: ${valueOrNone(faction.conflict)} | Relations: ${valueOrNone(faction.relations)}`).join('\n')),
        exportDetails(SECTION_NAMES.bonds, exportRelationRows(state).join('\n')),
        exportDetails(SECTION_NAMES.residue, state.residue.map((item) => `- ${valueOrNone(item.subject)} | Event: ${valueOrNone(item.event)} | Meaning: ${valueOrNone(item.meaning)} | Aftereffect: ${valueOrNone(item.aftereffect)} | Cue: ${valueOrNone(item.cue)}`).join('\n')),
        exportDetails(SECTION_NAMES.quests, state.quests.map((item) => `- <b>${valueOrNone(item.title ?? item.name)}</b> | State: ${valueOrNone(item.state)} | Objective: ${valueOrNone(item.objective)} | Progress: ${valueOrNone(item.progress)} | Reward: ${valueOrNone(item.reward)} | Lock/Owner: ${valueOrNone(item.lockOwner ?? item.owner)}`).join('\n')),
        exportDetails(SECTION_NAMES.inventory, `- <b>Inv:</b> ${valueOrNone(state.inventory.items)}<br>- <b>Titles/Skills:</b> ${valueOrNone(state.inventory.titlesSkills)}<br>- <b>Status:</b> ${valueOrNone(state.inventory.status)}<br>- <b>Mods:</b> ${valueOrNone(state.inventory.modifiers)}`),
        exportDetails(SECTION_NAMES.chekhov, `- Active: ${valueOrNone(state.chekhov.active)} | Locked: ${valueOrNone(state.chekhov.locked)} | Fired: ${valueOrNone(state.chekhov.fired)}`),
        exportDetails(SECTION_NAMES.thoughts, state.thoughts.map((item) => `- <b>${valueOrNone(item.actor ?? item.name)}</b> | Internal Thoughts: ${valueOrNone(item.thoughts ?? item.text)}`).join('\n')),
        exportDetails(SECTION_NAMES.notebook, state.notebook.map((item) => `- ${valueOrNone(typeof item === 'string' ? item : item.text ?? item.entry)}`).join('\n'), ' style="display:none;"'),
        exportDetails(SECTION_NAMES.dnd, state.lastDnd ? `- <b>Task:</b> ${valueOrNone(state.lastDnd.Task ?? state.lastDnd.task)}<br>- <b>Locked DC:</b> ${valueOrNone(state.lastDnd['Locked DC'] ?? state.lastDnd.lockedDc)}<br>- <b>User Roll:</b> ${valueOrNone(state.lastDnd['User Roll'] ?? state.lastDnd.userRoll)} | <b>NPC Roll:</b> ${valueOrNone(state.lastDnd['NPC Roll'] ?? state.lastDnd.npcRoll)}<br>- <b>Outcome:</b> ${valueOrNone(state.lastDnd.Outcome ?? state.lastDnd.outcome)}` : ''),
        state.worldSim?.raw || exportDetails(SECTION_NAMES.worldSim, '- None'),
        exportDetails(SECTION_NAMES.scene, `- Spotlight: ${valueOrNone(state.scene.spotlight)} | Open Beat: ${valueOrNone(state.scene.openBeat)} | Time Pressure: ${valueOrNone(state.scene.timePressure)}<br>- Env: ${valueOrNone(state.scene.environment)} | Positions: ${valueOrNone(Object.entries(state.scene.positions ?? {}).map(([id, position]) => `${actorLabel(state, id)}: ${position}`))}`),
    ].join('\n\n')));
    const opaque = state.opaque?.legacy;
    const unknownSections = Object.values(opaque?.sections ?? {}).filter((raw) => typeof raw === 'string' && raw.trim());
    const unknownLines = Object.entries(opaque?.unparsed ?? {}).flatMap(([section, values]) => (values ?? []).map((value) => `<!-- ST opaque ${section} -->\n${String(value)}`));
    if (unknownSections.length || unknownLines.length) lines.push(exportDetails('🗃️ OPAQUE LEGACY DATA', [...unknownSections, ...unknownLines].join('\n')));
    lines.push('</internal_states>');
    lines.push('<!-- GFX_END -->');
    return lines.join('\n');
}

export const exportLegacy = exportLegacyState;
export const importLegacy = importLegacyState;

