import { isPlainObject, sanitizePlainText, stableHash } from './util.js';

export const RESIDUE_FIELDS = Object.freeze(['subject', 'event', 'meaning', 'aftereffect', 'cue']);
export const MAX_RESIDUE_ENTRIES = 100;
export const RESIDUE_ID_PATTERN = /^r-[a-z0-9]+(?:-\d+)?$/;
export const NEW_RESIDUE_ID_PATTERN = /^new(?:-\d+)?$/;

function text(value, maxLength) {
    return sanitizePlainText(value, { maxLength, preserveNewlines: false }).trim();
}

export function normalizeResidueRecord(value) {
    const source = isPlainObject(value) ? value : { event: value };
    const record = {};
    for (const field of RESIDUE_FIELDS) {
        const clean = text(source[field] ?? (field === 'subject' ? source.actor ?? source.name : ''), field === 'subject' ? 200 : 2000);
        if (clean && !/^none$/i.test(clean)) record[field] = clean;
    }
    return record;
}

/** Stable transport IDs are derived, never stored in or exported with legacy state. */
export function residueEntries(residue) {
    const counts = new Map();
    return (Array.isArray(residue) ? residue : []).map((raw, index) => {
        const record = normalizeResidueRecord(raw);
        const base = `r-${stableHash({ subject: record.subject ?? '', event: record.event ?? '' })}`;
        const count = (counts.get(base) ?? 0) + 1;
        counts.set(base, count);
        return { id: count === 1 ? base : `${base}-${count}`, index, record };
    });
}

export function isResidueId(value, { allowNew = false } = {}) {
    const id = String(value ?? '').trim().toLowerCase();
    return RESIDUE_ID_PATTERN.test(id) || (allowNew && NEW_RESIDUE_ID_PATTERN.test(id));
}
