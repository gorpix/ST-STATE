import { deepClone, isPlainObject } from './util.js';

const PATCH_COMMENT = /<!--[\s]*ST_PATCH\b([\s\S]*?)-->/gi;
const DANGLING_PATCH_COMMENT = /<!--[\s]*ST_PATCH\b[\s\S]*$/gi;
const FLASH_HANDOFF = /<flash_handoff\b[^>]*\/?>(?:[\s\S]*?<\/flash_handoff\s*>)?/gi;

function jsonCandidate(body) {
    const value = String(body ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return value;
}

const NUMERIC_PATCH_FIELDS = new Set(['valence', 'arousal', 'dominance', 'agendaStep', 'agendaMax']);

function lineValue(field, value) {
    const text = String(value ?? '').trim();
    if (!NUMERIC_PATCH_FIELDS.has(field)) return text;
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
}

function parseLinePatch(candidate) {
    const lines = String(candidate ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines[0] !== 'V2') return null;
    const patch = { version: 2, base: '', mode: '', ops: [] };
    const creates = new Map();
    const actorSets = new Map();
    const sceneSet = {};
    const positions = {};
    for (const line of lines.slice(1)) {
        const equals = line.indexOf('=');
        if (equals > 0 && !line.includes('|')) {
            const key = line.slice(0, equals).trim();
            const value = line.slice(equals + 1).trim();
            if (key === 'base' || key === 'mode' || key === 'tx') patch[key] = value;
            else throw new Error(`Unknown ST_PATCH header: ${key}`);
            continue;
        }
        const parts = line.split('|');
        const operation = parts[0];
        if (operation === 'actor.set' || operation === 'actor.create') {
            if (parts.length < 4) throw new Error(`Malformed ST_PATCH line: ${line}`);
            const id = parts[1].trim();
            const field = parts[2].trim();
            const value = lineValue(field, parts.slice(3).join('|'));
            const target = operation === 'actor.create' ? creates : actorSets;
            if (!target.has(id)) target.set(id, {});
            target.get(id)[field] = value;
            continue;
        }
        if (operation === 'scene.set') {
            if (parts.length < 3) throw new Error(`Malformed ST_PATCH line: ${line}`);
            const field = parts[1].trim();
            sceneSet[field] = lineValue(field, parts.slice(2).join('|'));
            continue;
        }
        if (operation === 'scene.position') {
            if (parts.length < 3) throw new Error(`Malformed ST_PATCH line: ${line}`);
            positions[parts[1].trim()] = parts.slice(2).join('|').trim();
            continue;
        }
        throw new Error(`Unknown ST_PATCH line: ${line}`);
    }
    for (const [id, actor] of creates) patch.ops.push({ op: 'actor.create', id, actor });
    for (const [id, set] of actorSets) patch.ops.push({ op: 'actor.set', id, set });
    if (Object.keys(positions).length) sceneSet.positions = positions;
    if (Object.keys(sceneSet).length) patch.ops.push({ op: 'scene.set', set: sceneSet });
    return patch;
}

export function parsePatchComment(raw, body = undefined) {
    const candidate = jsonCandidate(body ?? String(raw ?? '').replace(/^<!--[\s]*ST_PATCH/i, '').replace(/-->\s*$/g, ''));
    try {
        const parsed = JSON.parse(candidate);
        if (!isPlainObject(parsed)) throw new Error('Patch JSON must be an object');
        return { ok: true, patch: parsed, raw: String(raw ?? ''), candidate, error: null };
    } catch (jsonError) {
        try {
            const parsed = parseLinePatch(candidate);
            if (parsed) return { ok: true, patch: parsed, raw: String(raw ?? ''), candidate, error: null, format: 'lines' };
        } catch (lineError) {
            return { ok: false, patch: null, raw: String(raw ?? ''), candidate, error: lineError?.message ?? 'Invalid line patch' };
        }
        return { ok: false, patch: null, raw: String(raw ?? ''), candidate, error: jsonError?.message ?? 'Invalid JSON' };
    }
}

export function hasFlashHandoff(text) {
    return /<flash_handoff\b[^>]*\/?>(?:[\s\S]*?<\/flash_handoff\s*>)?/i.test(String(text ?? ''));
}

export function removeControlPayload(text, { removeFlashHandoff = true } = {}) {
    let prose = String(text ?? '').replace(PATCH_COMMENT, '').replace(DANGLING_PATCH_COMMENT, '');
    if (removeFlashHandoff) prose = prose.replace(FLASH_HANDOFF, '');
    return prose;
}

/**
 * Extract the last ST_PATCH comment. All matching comments are reported so a
 * caller can remove control payload from display without exposing malformed JSON.
 */
export function extractHiddenPatch(text) {
    const source = String(text ?? '');
    const comments = [];
    let match;
    PATCH_COMMENT.lastIndex = 0;
    while ((match = PATCH_COMMENT.exec(source))) {
        const parsed = parsePatchComment(match[0], match[1]);
        comments.push({ ...parsed, start: match.index, end: PATCH_COMMENT.lastIndex });
    }
    PATCH_COMMENT.lastIndex = 0;
    const latest = comments.at(-1) ?? null;
    return {
        found: comments.length > 0,
        controlBearing: comments.length > 0 || /<!--[\s]*ST_PATCH\b/i.test(source) || hasFlashHandoff(source),
        complete: comments.length > 0,
        comments,
        latest,
        patch: latest?.ok ? deepClone(latest.patch) : null,
        ok: !!latest?.ok,
        error: latest && !latest.ok ? latest.error : null,
        flashHandoff: hasFlashHandoff(source),
        prose: removeControlPayload(source),
    };
}

export function messageText(message) {
    if (typeof message === 'string') return message;
    return String(message?.mes ?? message?.message ?? message?.content ?? '');
}

/** Update only visible/raw prose fields on an ST message object. */
export function stripMessageControlPayload(message, { removeFlashHandoff = true } = {}) {
    if (!message || typeof message !== 'object') return message;
    const prose = removeControlPayload(messageText(message), { removeFlashHandoff });
    if (Object.prototype.hasOwnProperty.call(message, 'mes')) message.mes = prose;
    else if (Object.prototype.hasOwnProperty.call(message, 'message')) message.message = prose;
    else if (Object.prototype.hasOwnProperty.call(message, 'content')) message.content = prose;
    if (Array.isArray(message.swipes)) message.swipes = message.swipes.map((swipe) => removeControlPayload(swipe, { removeFlashHandoff }));
    return message;
}

export const extractPatch = extractHiddenPatch;

