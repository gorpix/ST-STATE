/**
 * Local, presentation-only pop-in renderer for ST-ENDGAME graphics.
 *
 * The renderer intentionally accepts event objects that have already been
 * validated and sanitised by the state/prompt boundary.  It never interprets
 * those values as markup: all model-controlled values are assigned through
 * textContent.  No state mutation, generation, or network work belongs here.
 */

export const GFX_OVERLAY_ID = 'st-state-gfx-overlay';
export const DEFAULT_GFX_OVERLAY_OPTIONS = Object.freeze({
    enabled: true,
    reducedMotion: false,
    duration: 5000,
    maxVisible: 4,
});

const MEDIA_KINDS = new Set([
    'terminal', 'phone', 'paper', 'map', 'notice', 'credential', 'transaction',
    'web', 'broadcast', 'data', 'image', 'monitor', 'media', 'document',
    'letter', 'note', 'screen', 'radio', 'display',
]);

function text(value) {
    if (value === undefined || value === null) return '';
    return String(value);
}

function positiveInteger(value, fallback, maximum = 100) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(1, Math.min(maximum, Math.round(number)));
}

function durationValue(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(0, Math.min(86_400_000, Math.round(number)));
}

function classToken(value, fallback = 'artifact') {
    const candidate = text(value).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return candidate || fallback;
}

function eventId(event, sequence) {
    const value = event?.id ?? event?.eventId ?? event?.dedupeKey;
    return text(value).trim() || `gfx-event-${sequence}`;
}

function mediaKind(event) {
    const value = event?.medium ?? event?.media ?? event?.visualMedium ?? event?.kind ?? event?.type;
    const token = classToken(value);
    return token || 'artifact';
}

function phonePlatform(value) {
    const token = classToken(value, 'generic');
    return token === 'iphone' ? 'ios' : token;
}

function phoneStatusDetails(event) {
    const raw = text(event?.meta?.indicators ?? event?.meta?.battery ?? '').trim();
    const battery = raw.match(/\b(100|[1-9]?\d)\s*%/)?.[1] ?? '';
    const network = raw.match(/\b(5G|LTE|4G|3G|EDGE)\b/i)?.[1]?.toUpperCase() ?? '';
    return { raw, battery, network, wifi: /wi[ -]?fi/i.test(raw) || !network };
}

function appendPhoneStatus(documentRef, frame, platform, event) {
    const status = appendText(documentRef, frame, 'div', `st-gfx-phone-status st-gfx-phone-status-${platform}`);
    appendText(documentRef, status, 'span', 'st-gfx-phone-time', event.meta?.time ?? event.time ?? '');
    const details = phoneStatusDetails(event);
    const indicators = appendText(documentRef, status, 'span', 'st-gfx-phone-indicators');
    if (platform !== 'ios') {
        indicators.textContent = details.raw;
        return status;
    }
    const cellular = appendText(documentRef, indicators, 'span', 'st-gfx-ios-cellular');
    cellular.setAttribute?.('aria-hidden', 'true');
    for (let index = 1; index <= 4; index += 1) appendText(documentRef, cellular, 'i', `st-gfx-ios-cellular-bar st-gfx-ios-cellular-bar-${index}`);
    if (details.network) appendText(documentRef, indicators, 'span', 'st-gfx-ios-network', details.network);
    if (details.wifi) {
        const wifi = appendText(documentRef, indicators, 'span', 'st-gfx-ios-wifi');
        wifi.setAttribute?.('aria-hidden', 'true');
    }
    const battery = appendText(documentRef, indicators, 'span', 'st-gfx-ios-battery');
    battery.setAttribute?.('aria-label', details.battery ? `Battery ${details.battery}%` : 'Battery');
    appendText(documentRef, battery, 'span', 'st-gfx-ios-battery-level');
    if (details.battery) appendText(documentRef, battery, 'span', 'st-gfx-ios-battery-text', details.battery);
    return status;
}

function appendText(documentRef, parent, tag, className, value) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = text(value);
    parent.append(node);
    return node;
}

function rowEntries(event) {
    const payload = event?.payload;
    const rows = Array.isArray(event?.rows)
        ? event.rows
        : (Array.isArray(event?.textRows) ? event.textRows : (Array.isArray(payload?.rows) ? payload.rows : []));
    if (rows.length) return rows;

    const body = event?.body ?? event?.text ?? event?.message ?? event?.summary;
    if (Array.isArray(body)) return body;
    if (body !== undefined && body !== null && text(body) !== '') return [body];
    return [];
}

function appendRow(documentRef, list, row, index) {
    const role = row && typeof row === 'object' && !Array.isArray(row) ? row.role : undefined;
    const item = appendText(documentRef, list, 'div', `st-gfx-row st-gfx-row-role-${classToken(role, 'neutral')}`);
    item.dataset.index = String(index);
    if (row && typeof row === 'object' && !Array.isArray(row)) {
        const label = row.label ?? row.name ?? row.key;
        const value = row.value ?? row.text ?? row.content ?? row.body;
        if (label !== undefined && text(label) !== '') appendText(documentRef, item, 'span', 'st-gfx-row-label', label);
        appendText(documentRef, item, 'span', 'st-gfx-row-value', value === undefined ? row : value);
        if (row.time !== undefined && text(row.time) !== '') appendText(documentRef, item, 'time', 'st-gfx-row-time', row.time);
    } else {
        appendText(documentRef, item, 'span', 'st-gfx-row-value', row);
    }
    return item;
}

const PHONE_STATUS_META_KEYS = new Set(['time', 'battery', 'indicators', 'signal']);

function appendMeta(documentRef, card, event, { phone = false } = {}) {
    const source = event?.source ?? event?.origin ?? event?.from;
    if (source !== undefined && text(source) !== '') appendText(documentRef, card, 'div', 'st-gfx-source', source);
    const metadataInput = event?.meta && typeof event.meta === 'object' && !Array.isArray(event.meta) ? event.meta : {};
    const metadataValues = { ...metadataInput };
    if (phone) for (const key of PHONE_STATUS_META_KEYS) delete metadataValues[key];
    for (const key of ['actor', 'position', 'subtitle']) if (event?.[key] !== undefined && metadataValues[key] === undefined) metadataValues[key] = event[key];
    const meta = Object.keys(metadataValues).length ? metadataValues : event?.meta;
    if (meta === undefined || meta === null || meta === '') return;
    const metadata = appendText(documentRef, card, 'div', 'st-gfx-meta');
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        for (const [key, value] of Object.entries(meta)) {
            const subtitle = phone && key === 'subtitle';
            const entry = appendText(documentRef, metadata, 'span', `st-gfx-meta-item${subtitle ? ' st-gfx-meta-subtitle' : ''}`);
            if (!subtitle) appendText(documentRef, entry, 'span', 'st-gfx-meta-label', key);
            appendText(documentRef, entry, 'span', 'st-gfx-meta-value', value);
        }
    } else appendText(documentRef, metadata, 'span', 'st-gfx-meta-value', meta);
}

function normaliseOptions(options = {}) {
    const source = options && typeof options === 'object' ? options : {};
    return {
        enabled: source.enabled !== false && source.enable !== false,
        reducedMotion: Boolean(source.reducedMotion ?? source['reduced-motion']),
        duration: durationValue(source.duration ?? source.durationMs ?? source.ttlMs, DEFAULT_GFX_OVERLAY_OPTIONS.duration),
        maxVisible: positiveInteger(source.maxVisible ?? source['max-visible'], DEFAULT_GFX_OVERLAY_OPTIONS.maxVisible),
    };
}

function documentFor(options) {
    return options?.document ?? globalThis.document;
}

function resolveRoot(documentRef, requested) {
    if (!documentRef || typeof documentRef.createElement !== 'function') return null;
    if (requested && typeof requested === 'object' && typeof requested.append === 'function') return requested;
    if (typeof requested === 'string' && typeof documentRef.querySelector === 'function') {
        const selected = documentRef.querySelector(requested);
        if (selected) return selected;
    }
    if (typeof documentRef.querySelector === 'function') {
        const existing = documentRef.querySelector(`#${GFX_OVERLAY_ID}`);
        if (existing) return existing;
    }
    const root = documentRef.createElement('div');
    root.id = GFX_OVERLAY_ID;
    const parent = documentRef.body ?? documentRef.documentElement;
    if (!parent || typeof parent.append !== 'function') return null;
    parent.append(root);
    return root;
}

/** Presentation-only transient graphics layer. */
export class GfxOverlay {
    constructor(options = {}) {
        this.document = documentFor(options);
        this.options = normaliseOptions(options);
        this.root = resolveRoot(this.document, options.root ?? options.container);
        this.cards = new Map();
        this.timers = new Map();
        this.seen = new Set();
        this.sequence = 0;
        this.branchId = options.branchId === undefined ? null : text(options.branchId);
        this.ownsRoot = Boolean(this.root && this.root.id === GFX_OVERLAY_ID && !options.root && !options.container);
        if (this.root) this.#prepareRoot();
    }

    #prepareRoot() {
        this.root.classList?.add('st-gfx-overlay');
        this.root.setAttribute?.('role', 'log');
        this.root.setAttribute?.('aria-live', 'polite');
        this.root.setAttribute?.('aria-relevant', 'additions removals');
        this.root.setAttribute?.('aria-label', 'In-world graphics');
        this.root.classList?.toggle('st-gfx-reduced-motion', this.options.reducedMotion);
        this.root.hidden = !this.options.enabled;
    }

    configure(options = {}) {
        const next = normaliseOptions({ ...this.options, ...options });
        this.options = next;
        if (this.root) {
            this.root.classList?.toggle('st-gfx-reduced-motion', next.reducedMotion);
            this.root.hidden = !next.enabled;
        }
        if (!next.enabled) this.clear();
        this.#trim();
        return this;
    }

    /** Render one already-sanitised artifact event. Returns its card or null. */
    show(event) {
        if (!this.options.enabled || !this.root || !event || typeof event !== 'object') return null;
        if (event.visibility !== undefined && event.visibility !== 'public') return null;
        const id = eventId(event, ++this.sequence);
        const incomingBranch = event.branchId ?? event.branch ?? event.chatBranch ?? event.branchKey ?? event.branchIdentity;
        if (incomingBranch !== undefined && incomingBranch !== null) {
            const branch = text(incomingBranch);
            if (this.branchId !== null && branch !== this.branchId) this.replaceBranch(branch);
            else this.branchId = branch;
        }
        if (this.seen.has(id)) return this.cards.get(id) ?? null;

        const card = this.#card(event, id);
        this.seen.add(id);
        this.cards.set(id, card);
        this.root.append(card);
        this.#trim();
        const ttl = durationValue(event.duration ?? event.durationMs ?? event.ttlMs, this.options.duration);
        if (ttl > 0) {
            const timer = setTimeout(() => this.dismiss(id), ttl);
            // Node-based host tests should not be held open by a cosmetic TTL;
            // browsers simply ignore the optional unref method.
            timer?.unref?.();
            this.timers.set(id, timer);
        }
        return card;
    }

    render(event) { return this.show(event); }
    push(event) { return this.show(event); }
    emit(event) { return this.show(event); }

    #card(event, id) {
        const kind = mediaKind(event);
        const platform = phonePlatform(event.platform ?? event.devicePlatform ?? 'generic');
        const layout = classToken(event.layout ?? event.presentation ?? 'chat', 'chat');
        const card = this.document.createElement('article');
        card.className = `st-gfx-card st-gfx-kind-${classToken(kind)} st-gfx-media-${classToken(kind)} st-gfx-theme-${classToken(event.theme ?? kind)}${classToken(kind) === 'phone' ? ` st-gfx-phone-${platform} st-gfx-phone-layout-${layout}` : ''}`;
        card.dataset.eventId = id;
        card.dataset.media = kind;
        if (event.platform !== undefined || event.devicePlatform !== undefined) card.dataset.platform = platform;
        if (event.layout !== undefined || event.presentation !== undefined) card.dataset.layout = layout;
        if (this.branchId !== null) card.dataset.branchId = this.branchId;
        card.setAttribute?.('role', 'group');
        card.setAttribute?.('aria-label', text(event.title ?? event.name ?? event.label ?? 'In-world artifact'));

        const phone = classToken(kind) === 'phone';
        const frame = phone ? appendText(this.document, card, 'div', `st-gfx-phone-shell st-gfx-phone-${platform} st-gfx-phone-layout-${layout}`) : card;
        if (phone) {
            appendText(this.document, frame, 'div', `st-gfx-phone-notch st-gfx-phone-notch-${platform}`);
            appendPhoneStatus(this.document, frame, platform, event);
        }
        const heading = event.title ?? event.name ?? event.label ?? 'In-world artifact';
        const header = appendText(this.document, frame, 'header', 'st-gfx-header');
        appendText(this.document, header, 'span', 'st-gfx-kind', MEDIA_KINDS.has(classToken(kind)) ? classToken(kind) : 'artifact');
        appendText(this.document, header, 'h2', 'st-gfx-title', heading);
        appendMeta(this.document, frame, event, { phone });

        const rows = rowEntries(event);
        if (rows.length) {
            const list = appendText(this.document, frame, 'div', `st-gfx-rows${phone ? ' st-gfx-phone-rows' : ''}`);
            list.setAttribute?.('role', 'list');
            rows.forEach((row, index) => {
                const item = appendRow(this.document, list, row, index);
                item.setAttribute?.('role', 'listitem');
            });
        }
        return card;
    }

    dismiss(id) {
        const key = text(id);
        const card = this.cards.get(key);
        if (!card) return false;
        const timer = this.timers.get(key);
        if (timer !== undefined) clearTimeout(timer);
        this.timers.delete(key);
        this.cards.delete(key);
        card.remove?.();
        return true;
    }

    #trim() {
        while (this.cards.size > this.options.maxVisible) {
            const oldest = this.cards.keys().next().value;
            if (oldest === undefined) break;
            this.dismiss(oldest);
        }
    }

    clear() {
        for (const id of [...this.cards.keys()]) this.dismiss(id);
        this.seen.clear();
        return this;
    }

    /** Clear cards and start a new branch, optionally rendering its events. */
    replaceBranch(branchId, events = []) {
        this.clear();
        this.branchId = branchId === undefined || branchId === null ? null : text(branchId);
        if (Array.isArray(events)) for (const event of events) this.show(event);
        return this;
    }

    setBranch(branchId, events = []) { return this.replaceBranch(branchId, events); }
    branchChanged(branchId, events = []) { return this.replaceBranch(branchId, events); }
    updateBranch(branchId, events = []) { return this.replaceBranch(branchId, events); }
    clearBranch() { return this.clear(); }
    setOptions(options = {}) { return this.configure(options); }

    destroy() {
        this.clear();
        if (this.ownsRoot) this.root?.remove?.();
        this.root = null;
        return this;
    }
}

export function createGfxOverlay(options = {}) { return new GfxOverlay(options); }
export const mountGfxOverlay = createGfxOverlay;
