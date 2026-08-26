/** Small dependency-free helpers shared by the browser extension and tests. */

export const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function deepClone(value) {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

export function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function asFiniteInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

export function sanitizePlainText(value, { maxLength = 2000, preserveNewlines = true } = {}) {
    if (value === null || value === undefined) return '';
    let text = String(value);
    // Model/state fields are plain text. Strip markup and control bytes before they
    // can reach a dashboard or be re-injected into a prompt.
    text = text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\/?[a-z][^>]*>/gi, '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/\r\n?/g, '\n');
    if (!preserveNewlines) text = text.replace(/\s+/g, ' ');
    text = text.trim();
    return text.slice(0, maxLength);
}

export function sanitizeTextOrArray(value, options = {}) {
    if (Array.isArray(value)) {
        return value.map((item) => sanitizePlainText(item, options)).filter(Boolean);
    }
    return sanitizePlainText(value, options);
}

export function htmlDecode(value) {
    const text = String(value ?? '');
    // The legacy state only needs common entities. Numeric decoding keeps names
    // imported from HTML readable even when DOM is unavailable in unit tests.
    return text
        .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code) => {
            const radix = String(code).toLowerCase().startsWith('x') ? 16 : 10;
            const digits = String(code).replace(/^x/i, '');
            const point = Number.parseInt(digits, radix);
            return Number.isFinite(point) ? String.fromCodePoint(Math.min(point, 0x10ffff)) : '';
        })
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'");
}

export function plainTextFromHtml(value) {
    return htmlDecode(String(value ?? '')
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/p\s*>/gi, '\n')
        .replace(/<\/div\s*>/gi, '\n'))
        .replace(/<[^>]*>/g, '');
}

export function escapeHtmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Deterministic JSON useful for hashes and stable transaction identity. */
export function stableStringify(value) {
    const seen = new WeakSet();
    const normalize = (input) => {
        if (input === null || typeof input !== 'object') return input;
        if (seen.has(input)) return '[Circular]';
        seen.add(input);
        if (Array.isArray(input)) return input.map(normalize);
        const output = {};
        for (const key of Object.keys(input).sort()) output[key] = normalize(input[key]);
        return output;
    };
    return JSON.stringify(normalize(value));
}

/** A compact, non-cryptographic hash is sufficient for local heads/identities. */
export function hashString(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < String(value).length; index += 1) {
        hash ^= String(value).charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

export function stableHash(value) {
    return hashString(typeof value === 'string' ? value : stableStringify(value));
}

export function deepEqual(left, right) {
    return stableStringify(left) === stableStringify(right);
}

export function splitPipeFields(line) {
    // Legacy rows have no escaped pipe syntax; retaining empty fields is useful
    // for round-trip diagnostics and unknown-field preservation.
    return String(line ?? '').split('|').map((part) => part.trim());
}

export function firstNonEmpty(...values) {
    return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? '';
}

