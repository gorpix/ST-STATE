import { hashString, sanitizePlainText } from './util.js';

export const ACTOR_ID_PATTERN = /^[A-Z]{2}$/;

export function isValidActorId(value) {
    return typeof value === 'string' && ACTOR_ID_PATTERN.test(value);
}

export function normalizeActorId(value) {
    return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function isUserLabel(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'us'
        || normalized === 'user'
        || normalized === 'you'
        || normalized === '{{user}}'
        || normalized === 'player';
}

export function makeStableActorId(label, existing = {}) {
    if (isUserLabel(label)) return 'US';
    const text = sanitizePlainText(label, { maxLength: 200, preserveNewlines: false }) || 'NPC';
    const used = new Set(Object.keys(existing).map(normalizeActorId));
    const words = text.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    let candidate = '';
    if (words.length >= 2) candidate = `${words[0][0]}${words[1][0]}`.toUpperCase();
    else candidate = text.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
    if (!/^[A-Z]{2}$/.test(candidate)) candidate = 'NP';
    if (candidate !== 'US' && !used.has(candidate)) return candidate;

    const base = hashString(text).toUpperCase();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let offset = 0; offset < base.length; offset += 1) {
        const first = letters.charCodeAt(0) + (base.charCodeAt(offset) % 26);
        const second = letters.charCodeAt(0) + (base.charCodeAt((offset + 1) % base.length) % 26);
        const hashed = String.fromCharCode(first, second);
        if (hashed !== 'US' && !used.has(hashed)) return hashed;
    }
    for (let index = 0; index < 676; index += 1) {
        const generated = String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26));
        if (generated !== 'US' && !used.has(generated)) return generated;
    }
    throw new Error('No stable two-letter actor IDs remain');
}

export function canonicalActorId(value, actors = {}) {
    const id = normalizeActorId(value);
    if (isValidActorId(id)) return id;
    const match = Object.entries(actors).find(([, actor]) => String(actor?.name ?? '').toLowerCase() === String(value ?? '').trim().toLowerCase());
    return match?.[0] ?? '';
}

export function stableMessageIdentity(message, index = -1, chatId = '') {
    if (!message || typeof message !== 'object') return `message:${chatId}:${index}`;
    const explicit = message.extra?.stStateMessageId ?? message.stStateMessageId ?? message.message_id ?? message.id;
    if (explicit !== undefined && explicit !== null && String(explicit).trim()) return String(explicit);
    if (message.send_date !== undefined && message.send_date !== null) return `date:${chatId}:${message.send_date}:${index}`;
    const text = message.mes ?? message.message ?? message.content ?? '';
    return `message:${chatId}:${index}:${hashString(text)}`;
}

export function transactionIdentity(patch, messageIdentity = '') {
    const explicit = patch?.tx ?? patch?.transactionId ?? patch?.id;
    if (explicit !== undefined && explicit !== null && String(explicit).trim()) return String(explicit);
    return messageIdentity ? `message:${messageIdentity}` : `patch:${hashString(JSON.stringify(patch ?? {}))}`;
}


