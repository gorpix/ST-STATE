import { deepClone, isPlainObject, sanitizePlainText, stableHash, stableStringify } from './util.js';

/**
 * The model-facing GFX transport is deliberately a tiny line protocol.  It is
 * carried in an HTML comment so it is hidden by SillyTavern, but it never
 * contains model supplied HTML or JSON.  The renderer can consume the plain
 * object returned here without a DOM.
 */

export const GFX_PROTOCOL_VERSION = 'V1';
export const GFX_MAX_EVENTS = 1;
export const GFX_MAX_ROWS = 16;
export const GFX_MAX_LINE_LENGTH = 1200;
export const GFX_MAX_TITLE_LENGTH = 180;
export const GFX_MAX_FIELD_LENGTH = 300;
export const GFX_MAX_ROW_TEXT_LENGTH = 700;

// These are visual media, rather than arbitrary model-selected component
// names.  Keep this list small and explicit: unsupported kinds are ignored.
export const GFX_MEDIA_KINDS = Object.freeze([
    'terminal', 'phone', 'paper', 'map', 'notice', 'credential', 'transaction', 'web',
    'broadcast', 'data', 'image', 'monitor', 'media',
]);

const SUPPORTED_KINDS = new Set(GFX_MEDIA_KINDS);
const CONTROL = /<!--[ \t]*ST_GFX\b([\s\S]*?)-->/gi;
const DANGLING_CONTROL = /<!--[ \t]*ST_GFX\b[\s\S]*$/gi;
const HEADER_FIELDS = new Set(['kind', 'title', 'subtitle', 'source', 'actor', 'position', 'theme', 'duration', 'id', 'platform', 'layout', 'mode', 'visibility']);
const ROW_KEYS = new Set(['row', 'content', 'line']);

function text(value, maxLength) {
    return sanitizePlainText(value, { maxLength, preserveNewlines: false });
}

function safeStable(value) {
    try { return stableStringify(value); } catch { return String(value ?? ''); }
}

function clone(value, seen = new WeakMap()) {
    try { return deepClone(value); } catch { /* fall through to a cycle-safe copy */ }
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return null;
    seen.set(value, true);
    if (Array.isArray(value)) return value.map((entry) => clone(entry, seen));
    if (!isPlainObject(value)) return String(value);
    const result = {};
    for (const [key, entry] of Object.entries(value)) result[key] = clone(entry, seen);
    return result;
}

function canonicalKind(value) {
    const kind = text(value, 40).toLowerCase();
    return ({ letter: 'paper', note: 'paper', screen: 'web', display: 'web', radio: 'broadcast' })[kind] ?? kind;
}

/** Split protocol pipes while permitting a literal escaped \| in text. */
function splitLine(value) {
    const result = [];
    let current = '';
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char === '\\' && value[index + 1] === '|') {
            current += '|'; index += 1;
        } else if (char === '\\' && value[index + 1] === '\\') {
            current += '\\'; index += 1;
        } else if (char === '|') {
            result.push(current); current = '';
        } else current += char;
    }
    result.push(current);
    return result;
}

function makeId(event) {
    // An explicit model id is retained as a display/reference field, but is
    // not trusted for identity.  The hash is stable for identical content and
    // changes whenever a meaningful field or row changes.
    const identity = {
        kind: event.kind,
        title: event.title,
        subtitle: event.subtitle,
        source: event.source,
        actor: event.actor,
        position: event.position,
        theme: event.theme,
        duration: event.duration,
        platform: event.platform,
        layout: event.layout,
        mode: event.mode,
        visibility: event.visibility,
        rows: event.rows,
    };
    return `gfx-${stableHash(safeStable(identity))}`;
}

function parseRow(parts, line) {
    if (parts.length < 2) return { error: `Malformed row: ${line}` };
    let role = '';
    let label = '';
    let value = '';
    let time = '';
    if (parts.length === 2) {
        value = parts[1];
    } else if (parts.length === 3) {
        label = parts[1];
        value = parts[2];
    } else if (parts.length === 4) {
        role = parts[1];
        label = parts[2];
        value = parts[3];
    } else {
        // Canonical row grammar: row|role|label|time|text. The text is the
        // remainder, so escaped or literal pipes are not silently discarded.
        role = parts[1];
        label = parts[2];
        time = parts[3];
        value = parts.slice(4).join('|');
    }
    value = text(value, GFX_MAX_ROW_TEXT_LENGTH);
    label = text(label, GFX_MAX_FIELD_LENGTH);
    if (!value) return { error: `Empty row: ${line}` };
    const row = { label, text: value };
    role = text(role, 40).toLowerCase();
    time = text(time, 80);
    if (role) row.role = role;
    if (time) row.time = time;
    return { row };
}

/** Parse one V1 body. This function never throws for malformed model input. */
export function parseGfxProtocol(raw, body = undefined) {
    const source = String(raw ?? '');
    const candidate = String(body ?? source.replace(/^<!--[ \t]*ST_GFX\b/i, '').replace(/-->[ \t]*$/i, ''));
    const physicalLines = candidate.split(/\r?\n/);
    const lines = physicalLines.map((line) => line.trim()).filter(Boolean);
    const errors = [];
    if (lines.length === 0 || lines[0] !== GFX_PROTOCOL_VERSION) {
        return { ok: false, event: null, errors: ['Missing GFX protocol V1 header'], raw: source, candidate };
    }

    const fields = {};
    const rows = [];
    for (const line of lines.slice(1)) {
        if (line.length > GFX_MAX_LINE_LENGTH) {
            errors.push('GFX line exceeds maximum length');
            continue;
        }
        const parts = splitLine(line);
        const first = parts[0].trim();
        const equalsRow = first.indexOf('=');
        const rowKey = equalsRow > 0 ? first.slice(0, equalsRow).trim().toLowerCase() : first.toLowerCase();
        if (ROW_KEYS.has(rowKey)) {
            if (rows.length >= GFX_MAX_ROWS) {
                errors.push('GFX row limit exceeded');
                continue;
            }
            const rowParts = equalsRow > 0 ? [first.slice(0, equalsRow), first.slice(equalsRow + 1), ...parts.slice(1)] : parts;
            const parsed = parseRow(rowParts, line);
            if (parsed.error) errors.push(parsed.error);
            else rows.push(parsed.row);
            continue;
        }
        const equals = line.indexOf('=');
        if (equals <= 0) {
            errors.push(`Malformed GFX line: ${line.slice(0, 100)}`);
            continue;
        }
        const key = line.slice(0, equals).trim().toLowerCase();
        const value = line.slice(equals + 1).trim();
        if (!HEADER_FIELDS.has(key)) {
            errors.push(`Unknown GFX field: ${key}`);
            continue;
        }
        if (key === 'kind' && fields.kind !== undefined) errors.push('Duplicate GFX kind');
        fields[key] = value;
    }

    const kind = canonicalKind(fields.kind);
    if (!SUPPORTED_KINDS.has(kind)) errors.push(`Unsupported GFX media kind: ${kind || '(missing)'}`);
    const title = text(fields.title, GFX_MAX_TITLE_LENGTH);
    if (!title) errors.push('Missing GFX title');
    if (rows.length === 0) errors.push('GFX event requires at least one row');
    const mode = canonicalKind(fields.mode);
    if (mode !== 'normal') errors.push('GFX mode must be NORMAL');
    const visibility = canonicalKind(fields.visibility);
    if (!['visible', 'public'].includes(visibility)) errors.push('GFX visibility must be visible or public');

    const event = {
        id: '',
        kind,
        title,
        mode: 'NORMAL',
        // `visible` is accepted on the wire and canonicalized to the
        // renderer's public-audience value. Private/internal artifacts never
        // leave the parser as accepted events.
        visibility: 'public',
        rows: rows.map((row) => ({ ...row })),
    };
    for (const field of ['subtitle', 'source', 'actor', 'position', 'theme']) {
        const value = text(fields[field], GFX_MAX_FIELD_LENGTH);
        if (value) event[field] = value;
    }
    if (fields.duration !== undefined) {
        const duration = Number(fields.duration);
        if (Number.isFinite(duration) && duration >= 0) event.duration = Math.min(86400, Math.trunc(duration));
        else errors.push('Invalid GFX duration');
    }
    if (fields.platform !== undefined) {
        const platformValue = canonicalKind(fields.platform);
        const platform = platformValue === 'iphone' ? 'ios' : platformValue;
        if (kind !== 'phone' || !['ios', 'android'].includes(platform)) errors.push('Invalid GFX phone platform');
        else event.platform = platform;
    } else if (kind === 'phone') {
        event.platform = 'ios';
    }
    if (fields.layout !== undefined) {
        const layout = canonicalKind(fields.layout);
        if (kind !== 'phone' || !['chat', 'notification', 'call', 'email'].includes(layout)) errors.push('Invalid GFX phone layout');
        else event.layout = layout;
    } else if (kind === 'phone') {
        event.layout = 'chat';
    }
    // The supplied id is non-authoritative and bounded; it is useful to a
    // renderer for correlation while the deterministic hash remains `id`.
    const suppliedId = text(fields.id, GFX_MAX_FIELD_LENGTH);
    if (suppliedId) event.sourceId = suppliedId;
    if (errors.length) return { ok: false, event: null, errors, raw: source, candidate };
    event.id = makeId(event);
    return { ok: true, event, errors, raw: source, candidate };
}

/** Extract every recognized hidden GFX envelope from prose. */
export function extractGfxProtocol(input) {
    const source = String(input ?? '');
    const controls = [];
    let match;
    CONTROL.lastIndex = 0;
    while ((match = CONTROL.exec(source))) {
        controls.push({ ...parseGfxProtocol(match[0], match[1]), start: match.index, end: CONTROL.lastIndex });
    }
    CONTROL.lastIndex = 0;
    const duplicateErrors = controls.length > GFX_MAX_EVENTS ? ['Only one ST_GFX control is allowed per response'] : [];
    const events = duplicateErrors.length ? [] : controls.filter((control) => control.ok).map((control) => clone(control.event));
    const errors = [...duplicateErrors, ...controls.flatMap((control) => control.errors ?? [])];
    return {
        found: controls.length > 0,
        controlBearing: controls.length > 0 || /<!--[ \t]*ST_GFX\b/i.test(source),
        complete: controls.length > 0,
        ok: controls.length > 0 && duplicateErrors.length === 0 && controls.every((control) => control.ok),
        events,
        controls,
        errors,
        // Strip only our recognized comment envelope. Ordinary comments and
        // all unrecognized markup remain visible to the caller.
        prose: source.replace(CONTROL, '').replace(DANGLING_CONTROL, ''),
    };
}

export const extractGfxEvents = extractGfxProtocol;
export const extractGfx = extractGfxProtocol;
export const extractGfxControl = extractGfxProtocol;
export const parseGfx = parseGfxProtocol;
export const parseGfxControl = parseGfxProtocol;

export function removeGfxControl(textValue) {
    return String(textValue ?? '').replace(CONTROL, '').replace(DANGLING_CONTROL, '');
}

export const stripGfxControl = removeGfxControl;
export const stripGfx = removeGfxControl;

/** Return a deep-safe copy suitable for handing to a renderer. */
export function cloneGfxEvent(event) {
    if (!isPlainObject(event)) return null;
    return clone(event);
}
