import { deepClone, isPlainObject } from './util.js';

const PATCH_COMMENT = /<!--[\s]*FF5_PATCH\b([\s\S]*?)-->/gi;
const FLASH_HANDOFF = /<flash_handoff\b[^>]*\/?>(?:[\s\S]*?<\/flash_handoff\s*>)?/gi;

function jsonCandidate(body) {
    const value = String(body ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return value;
}

export function parsePatchComment(raw, body = undefined) {
    const candidate = jsonCandidate(body ?? String(raw ?? '').replace(/^<!--[\s]*FF5_PATCH/i, '').replace(/-->\s*$/g, ''));
    try {
        const parsed = JSON.parse(candidate);
        if (!isPlainObject(parsed)) throw new Error('Patch JSON must be an object');
        return { ok: true, patch: parsed, raw: String(raw ?? ''), candidate, error: null };
    } catch (error) {
        return { ok: false, patch: null, raw: String(raw ?? ''), candidate, error: error?.message ?? 'Invalid JSON' };
    }
}

export function hasFlashHandoff(text) {
    return /<flash_handoff\b[^>]*\/?>(?:[\s\S]*?<\/flash_handoff\s*>)?/i.test(String(text ?? ''));
}

export function removeControlPayload(text, { removeFlashHandoff = true } = {}) {
    let prose = String(text ?? '').replace(PATCH_COMMENT, '');
    if (removeFlashHandoff) prose = prose.replace(FLASH_HANDOFF, '');
    return prose;
}

/**
 * Extract the last FF5_PATCH comment. All matching comments are reported so a
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

