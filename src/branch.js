import { deepClone, isPlainObject, stableHash } from './util.js';

/**
 * Branch bookkeeping is deliberately separate from the canonical state
 * reducer.  A slot is one assistant response position in a chat.  Its
 * checkpoint is the canonical document immediately before that response, so
 * choosing another swipe can always evaluate from the same ct/head.
 */
export const BRANCH_SCHEMA_VERSION = 1;
export const DEFAULT_BRANCH_HISTORY = 100;
export const DEFAULT_BRANCH_SLOTS = 12;
export const MAX_BRANCH_LEDGER_CHARS = 1_500_000;
export const BRANCH_SIDECAR_KEY = 'stStateBranches';

function bounded(value, max) {
    return Array.isArray(value) ? value.slice(-max).map((entry) => deepClone(entry)) : [];
}

function positiveLimit(value, fallback = DEFAULT_BRANCH_HISTORY) {
    const limit = Number.isInteger(value) && value > 0 ? value : fallback;
    return Math.min(limit, 1000);
}

function slotLimit(value) {
    const limit = Number.isInteger(value) && value > 0 ? value : DEFAULT_BRANCH_SLOTS;
    return Math.min(limit, 50);
}

function pruneSlots(ledger) {
    const slots = Object.values(ledger.slots);
    if (slots.length <= ledger.maxSlots) return ledger;
    const retained = slots
        .sort((left, right) => {
            if (left.index !== right.index) return right.index - left.index;
            return Number(right.history.at(-1)?.at ?? 0) - Number(left.history.at(-1)?.at ?? 0);
        })
        .slice(0, ledger.maxSlots);
    ledger.slots = Object.fromEntries(retained.map((slot) => [slot.slotId, slot]));
    return ledger;
}

function text(value) {
    return value === undefined || value === null ? '' : String(value);
}

function slotIdFor({ slotId, messageId = '', index = -1 } = {}) {
    if (text(slotId).trim()) return text(slotId).trim();
    if (text(messageId).trim()) return `slot:${text(messageId).trim()}`;
    return `slot:index:${Number.isInteger(index) ? index : -1}`;
}

/** Stable, content-independent identity for a swipe in one assistant slot. */
export function stableSwipeIdentity({ slotId, messageId = '', swipeId, contentHash = '', swipeIndex = 0, index = -1 } = {}) {
    const slot = slotIdFor({ slotId, messageId, index });
    if (swipeId !== undefined && swipeId !== null && text(swipeId).trim()) return `swipe:${slot}:id:${text(swipeId).trim()}`;
    const hashedContent = text(contentHash).trim();
    if (hashedContent) return `swipe:${slot}:content:${hashedContent}`;
    const ordinal = Number.isInteger(swipeIndex) && swipeIndex >= 0 ? swipeIndex : 0;
    return `swipe:${slot}:index:${ordinal}`;
}

export function stableSlotIdentity(options = {}) {
    return slotIdFor(options);
}

function cleanSwipe(input, fallback = {}) {
    const value = isPlainObject(input) ? input : {};
    const id = text(value.id || fallback.id);
    const index = Number.isInteger(value.index) && value.index >= 0
        ? value.index
        : (Number.isInteger(fallback.index) && fallback.index >= 0 ? fallback.index : 0);
    return {
        id: id || stableSwipeIdentity({ slotId: fallback.slotId, messageId: value.messageId || fallback.messageId, swipeId: value.identity || value.swipeId, swipeIndex: index }),
        index,
        messageId: text(value.messageId || fallback.messageId),
        contentHash: text(value.contentHash || fallback.contentHash),
        commitMode: value.commitMode === 'NATIVE' ? 'NATIVE' : '',
        commitCt: Number.isInteger(value.commitCt) ? value.commitCt : null,
        commitHead: text(value.commitHead),
        diff: Array.isArray(value.diff) ? deepClone(value.diff).slice(0, 500) : [],
        status: value.status === 'invalidated' ? 'invalidated' : 'active',
        createdAt: Number.isFinite(value.createdAt) ? value.createdAt : fallback.createdAt,
        invalidatedAt: Number.isFinite(value.invalidatedAt) ? value.invalidatedAt : undefined,
        reason: value.reason ? text(value.reason).slice(0, 400) : undefined,
    };
}

function cleanSlot(input, maxHistory) {
    const value = isPlainObject(input) ? input : {};
    const slotId = slotIdFor(value);
    const checkpoint = value.checkpoint === undefined ? null : deepClone(value.checkpoint);
    const swipes = {};
    if (isPlainObject(value.swipes)) {
        for (const [key, item] of Object.entries(value.swipes)) {
            const swipe = cleanSwipe(item, { id: key, slotId, messageId: value.messageId });
            if (swipe.id) swipes[swipe.id] = swipe;
        }
    }
    const selected = value.selectedSwipeId && swipes[value.selectedSwipeId] && swipes[value.selectedSwipeId].status !== 'invalidated'
        ? value.selectedSwipeId
        : null;
    return {
        slotId,
        messageId: text(value.messageId),
        index: Number.isInteger(value.index) ? value.index : -1,
        checkpoint,
        checkpointCt: Number.isInteger(value.checkpointCt) ? value.checkpointCt : (Number.isInteger(checkpoint?.ct) ? checkpoint.ct : null),
        checkpointHead: text(value.checkpointHead || checkpoint?.head),
        selectedSwipeId: selected,
        selectedSwipeIndex: selected ? (swipes[selected]?.index ?? 0) : null,
        revision: Number.isInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
        status: ['active', 'edited', 'deleted'].includes(value.status) ? value.status : 'active',
        swipes,
        history: bounded(value.history, maxHistory),
    };
}

export function createBranchLedger(options = {}) {
    const maxHistory = positiveLimit(options.maxHistory);
    return {
        schemaVersion: BRANCH_SCHEMA_VERSION,
        maxHistory,
        maxSlots: slotLimit(options.maxSlots),
        slots: {},
        events: [],
    };
}

/** Normalize persisted branch data without retaining references to callers. */
export function normalizeBranchLedger(input, options = {}) {
    const raw = isPlainObject(input) ? input : {};
    const maxHistory = positiveLimit(raw.maxHistory ?? options.maxHistory);
    const result = createBranchLedger({ maxHistory, maxSlots: raw.maxSlots ?? options.maxSlots });
    if (isPlainObject(raw.slots)) {
        for (const [key, value] of Object.entries(raw.slots)) {
            const slot = cleanSlot(value, maxHistory);
            slot.slotId = key || slot.slotId;
            result.slots[slot.slotId] = slot;
        }
    }
    result.events = bounded(raw.events, maxHistory);
    return pruneSlots(result);
}

export function branchLedgerSize(input) {
    return JSON.stringify(normalizeBranchLedger(input)).length;
}

export function assertBranchLedgerSize(input, limit = MAX_BRANCH_LEDGER_CHARS) {
    const size = branchLedgerSize(input);
    if (size > limit) throw new RangeError(`Branch checkpoint ledger is too large (${size} > ${limit} characters)`);
    return size;
}

/**
 * Fit persisted branch data under its storage cap by dropping only the oldest
 * assistant slots. The newest/current slot is retained so generation can
 * continue; older missing checkpoints remain reconstructable from chat.
 */
export function fitBranchLedgerSize(input, { limit = MAX_BRANCH_LEDGER_CHARS, preserveSlotId = '' } = {}) {
    const ledger = normalizeBranchLedger(input);
    const protectedSlotId = preserveSlotId || text(ledger.events.at(-1)?.slotId);
    const retained = () => JSON.stringify(ledger).length;
    let size = retained();
    const removedSlotIds = [];
    const candidates = Object.values(ledger.slots).sort((left, right) => {
        const leftPreserved = left.slotId === protectedSlotId ? 1 : 0;
        const rightPreserved = right.slotId === protectedSlotId ? 1 : 0;
        if (leftPreserved !== rightPreserved) return leftPreserved - rightPreserved;
        const leftInactive = left.status === 'active' ? 1 : 0;
        const rightInactive = right.status === 'active' ? 1 : 0;
        if (leftInactive !== rightInactive) return leftInactive - rightInactive;
        if (left.index !== right.index) return left.index - right.index;
        return Number(left.history.at(-1)?.at ?? 0) - Number(right.history.at(-1)?.at ?? 0);
    });
    while (size > limit && Object.keys(ledger.slots).length > 1) {
        const oldest = candidates.shift();
        if (!oldest) break;
        delete ledger.slots[oldest.slotId];
        ledger.events = ledger.events.filter((event) => event?.slotId !== oldest.slotId);
        removedSlotIds.push(oldest.slotId);
        size = retained();
    }
    if (size > limit) throw new RangeError(`Branch checkpoint ledger is too large (${size} > ${limit} characters)`);
    return { ledger, size, removedSlotIds };
}

/** Return the newest retained pre-response checkpoint. */
export function latestAssistantCheckpoint(input, options = {}) {
    const ledger = normalizeBranchLedger(input, options);
    const slots = Object.values(ledger.slots)
        .filter((slot) => slot.checkpoint !== null && slot.status !== 'deleted')
        .sort((left, right) => {
            if (left.index !== right.index) return right.index - left.index;
            const leftAt = Number(left.history.at(-1)?.at ?? 0);
            const rightAt = Number(right.history.at(-1)?.at ?? 0);
            return rightAt - leftAt;
        });
    const slot = slots[0];
    if (!slot) return { ledger, ok: false, reason: 'missing_checkpoint' };
    return {
        ledger,
        ok: true,
        slotId: slot.slotId,
        messageId: slot.messageId,
        index: slot.index,
        checkpoint: deepClone(slot.checkpoint),
        restoreState: deepClone(slot.checkpoint),
        state: deepClone(slot.checkpoint),
        checkpointCt: slot.checkpointCt,
        checkpointHead: slot.checkpointHead,
    };
}

function eventId(kind, slot, payload = {}) {
    return `branch:${kind}:${stableHash({ slotId: slot.slotId, messageId: slot.messageId, ...payload })}`;
}

function recordEvent(ledger, slot, kind, payload = {}, at = Date.now()) {
    const event = {
        id: eventId(kind, slot, payload),
        kind,
        slotId: slot.slotId,
        messageId: slot.messageId || null,
        at: Number.isFinite(at) ? at : Date.now(),
        ...deepClone(payload),
    };
    // Replaying the same host event must not grow history or create a second
    // canonical marker.  The ID intentionally excludes the wall-clock time.
    ledger.events = [...ledger.events.filter((entry) => entry?.id !== event.id), event].slice(-ledger.maxHistory);
    slot.history = [...slot.history.filter((entry) => entry?.id !== event.id), event].slice(-ledger.maxHistory);
    return event;
}

function ensureSwipe(slot, options = {}, at = Date.now()) {
    const id = text(options.swipeIdentity || options.swipeId).trim() || stableSwipeIdentity({
        slotId: slot.slotId,
        messageId: slot.messageId,
        swipeId: options.swipeId,
        swipeIndex: options.swipeIndex,
        index: slot.index,
    });
    const index = Number.isInteger(options.swipeIndex) && options.swipeIndex >= 0 ? options.swipeIndex : 0;
    const existing = slot.swipes[id];
    const swipe = existing ?? cleanSwipe({ id, index, messageId: slot.messageId, contentHash: options.contentHash, createdAt: at }, { id, index, slotId: slot.slotId, messageId: slot.messageId, createdAt: at });
    if (options.contentHash !== undefined) swipe.contentHash = text(options.contentHash);
    if (!existing) slot.swipes[id] = swipe;
    return swipe;
}

function checkpointResult(ledger, slot, swipe) {
    return {
        ledger,
        slotId: slot.slotId,
        messageId: slot.messageId,
        selectedSwipeId: slot.selectedSwipeId,
        selectedSwipeIndex: slot.selectedSwipeIndex,
        selectedSwipe: slot.selectedSwipeId ? deepClone(slot.swipes[slot.selectedSwipeId] ?? null) : null,
        checkpoint: deepClone(slot.checkpoint),
        restoreState: deepClone(slot.checkpoint),
        state: deepClone(slot.checkpoint),
        checkpointCt: slot.checkpointCt,
        checkpointHead: slot.checkpointHead,
        swipe: deepClone(swipe ?? null),
    };
}

/** Capture the pre-response canonical state once for an assistant slot. */
export function checkpointAssistantSlot(input, options = {}) {
    const ledger = normalizeBranchLedger(input, options);
    const slotId = slotIdFor(options);
    const created = !ledger.slots[slotId];
    const slot = ledger.slots[slotId] ?? cleanSlot({ slotId, messageId: options.messageId, index: options.index }, ledger.maxHistory);
    const replace = options.replace === true || (!created && slot.status !== 'active');
    if (!ledger.slots[slotId] || replace) {
        slot.slotId = slotId;
        slot.messageId = text(options.messageId || slot.messageId);
        slot.index = Number.isInteger(options.index) ? options.index : slot.index;
        if (options.state !== undefined) {
            slot.checkpoint = deepClone(options.state);
            slot.checkpointCt = Number.isInteger(options.state?.ct) ? options.state.ct : null;
            slot.checkpointHead = text(options.state?.head);
        }
        slot.status = 'active';
        slot.revision = (slot.revision ?? 0) + (replace ? 1 : 0);
        if (replace) {
            slot.swipes = {};
            slot.selectedSwipeId = null;
            slot.selectedSwipeIndex = null;
        }
        ledger.slots[slotId] = slot;
    }
    const swipe = ensureSwipe(slot, options, options.at);
    if (!slot.selectedSwipeId) {
        slot.selectedSwipeId = swipe.id;
        slot.selectedSwipeIndex = swipe.index;
    }
    const event = recordEvent(ledger, slot, 'checkpoint', { swipeId: swipe.id, revision: slot.revision }, options.at);
    pruneSlots(ledger);
    return { ...checkpointResult(ledger, slot, swipe), created, event };
}

/** Register a response swipe while retaining the slot's original checkpoint. */
export function registerAssistantSwipe(input, options = {}) {
    const ledger = normalizeBranchLedger(input, options);
    const slotId = slotIdFor(options);
    const slot = ledger.slots[slotId];
    if (!slot) return { ledger, ok: false, reason: 'missing_slot', slotId };
    const swipe = ensureSwipe(slot, options, options.at);
    const event = recordEvent(ledger, slot, 'swipe', { swipeId: swipe.id, swipeIndex: swipe.index }, options.at);
    return { ...checkpointResult(ledger, slot, swipe), ok: true, event };
}

/** Persist the bounded post-response diff required to replay a Native swipe. */
export function recordAssistantSwipeResult(input, options = {}) {
    const ledger = normalizeBranchLedger(input, options);
    const slotId = slotIdFor(options);
    const slot = ledger.slots[slotId];
    if (!slot) return { ledger, ok: false, reason: 'missing_slot', slotId };
    const swipe = ensureSwipe(slot, options, options.at);
    swipe.commitMode = options.mode === 'NATIVE' ? 'NATIVE' : '';
    swipe.commitCt = Number.isInteger(options.state?.ct) ? options.state.ct : null;
    swipe.commitHead = text(options.state?.head);
    swipe.diff = Array.isArray(options.diff) ? deepClone(options.diff).slice(0, 500) : [];
    const event = recordEvent(ledger, slot, 'swipe_result', { swipeId: swipe.id, mode: swipe.commitMode, ct: swipe.commitCt }, options.at);
    const fitted = fitBranchLedgerSize(ledger, { preserveSlotId: slotId });
    const retainedSlot = fitted.ledger.slots[slotId];
    const retainedSwipe = retainedSlot?.swipes?.[swipe.id] ?? swipe;
    return { ...checkpointResult(fitted.ledger, retainedSlot ?? slot, retainedSwipe), ok: true, event, prunedSlots: fitted.removedSlotIds };
}

/**
 * Select a swipe and return the pre-slot snapshot that must be restored before
 * evaluating it.  No ct/head is incremented here; the reducer can therefore
 * commit the selected response exactly once from the same baseline.
 */
export function selectAssistantSwipe(input, options = {}) {
    const ledger = normalizeBranchLedger(input, options);
    const slotId = slotIdFor(options);
    const slot = ledger.slots[slotId];
    if (!slot) return { ledger, ok: false, reason: 'missing_slot', slotId };
    const swipe = ensureSwipe(slot, options, options.at);
    if (swipe.status === 'invalidated') return { ledger, ok: false, reason: 'invalidated_swipe', slotId, swipe: deepClone(swipe) };
    slot.selectedSwipeId = swipe.id;
    slot.selectedSwipeIndex = swipe.index;
    const event = recordEvent(ledger, slot, 'select', { swipeId: swipe.id, swipeIndex: swipe.index }, options.at);
    return { ...checkpointResult(ledger, slot, swipe), ok: true, requiresRebaseline: true, event };
}

/** Alias emphasizing the operation's integration point with the reducer. */
export const prepareSwipeEvaluation = selectAssistantSwipe;

export function invalidateAssistantSwipe(input, options = {}) {
    const ledger = normalizeBranchLedger(input, options);
    const slotId = slotIdFor(options);
    const slot = ledger.slots[slotId];
    if (!slot) return { ledger, ok: false, reason: 'missing_slot', slotId };
    const id = text(options.swipeIdentity || options.swipeId).trim() || stableSwipeIdentity({ slotId, messageId: slot.messageId, swipeIndex: options.swipeIndex, index: slot.index });
    const swipe = slot.swipes[id] ?? ensureSwipe(slot, { ...options, swipeIdentity: id }, options.at);
    swipe.status = 'invalidated';
    swipe.invalidatedAt = Number.isFinite(options.at) ? options.at : Date.now();
    swipe.reason = text(options.reason || 'invalidated').slice(0, 400);
    if (slot.selectedSwipeId === id) {
        slot.selectedSwipeId = null;
        slot.selectedSwipeIndex = null;
    }
    const event = recordEvent(ledger, slot, 'invalidate_swipe', { swipeId: id, reason: swipe.reason }, options.at);
    return { ...checkpointResult(ledger, slot, swipe), ok: true, event };
}

function invalidateSlot(input, options, kind) {
    const ledger = normalizeBranchLedger(input, options);
    const slotId = slotIdFor(options);
    const slot = ledger.slots[slotId];
    if (!slot) return { ledger, ok: false, reason: 'missing_slot', slotId };
    slot.status = kind === 'delete' ? 'deleted' : 'edited';
    slot.revision += 1;
    for (const swipe of Object.values(slot.swipes)) {
        swipe.status = 'invalidated';
        swipe.invalidatedAt = Number.isFinite(options.at) ? options.at : Date.now();
        swipe.reason = kind === 'delete' ? 'message_deleted' : 'message_edited';
    }
    slot.selectedSwipeId = null;
    slot.selectedSwipeIndex = null;
    const event = recordEvent(ledger, slot, kind === 'delete' ? 'invalidate_delete' : 'invalidate_edit', {
        revision: slot.revision,
        reason: text(options.reason || (kind === 'delete' ? 'message_deleted' : 'message_edited')).slice(0, 400),
    }, options.at);
    return { ...checkpointResult(ledger, slot, null), ok: true, event };
}

export function invalidateAssistantEdit(input, options = {}) { return invalidateSlot(input, options, 'edit'); }
export function invalidateAssistantDelete(input, options = {}) { return invalidateSlot(input, options, 'delete'); }

// Short aliases keep event-handler wiring readable while the verbose names
// remain useful at call sites that distinguish assistant messages explicitly.
export const checkpointSlot = checkpointAssistantSlot;
export const registerSwipe = registerAssistantSwipe;
export const selectSwipe = selectAssistantSwipe;
export const invalidateSwipe = invalidateAssistantSwipe;
export const invalidateEdit = invalidateAssistantEdit;
export const invalidateDelete = invalidateAssistantDelete;

/** Return the selected slot's checkpoint as an explicit restore operation. */
export function restoreAssistantCheckpoint(input, options = {}) {
    const ledger = normalizeBranchLedger(input, options);
    const slotId = slotIdFor(options);
    const slot = ledger.slots[slotId];
    if (!slot || slot.checkpoint === null) return { ledger, ok: false, reason: 'missing_checkpoint', slotId };
    return {
        ledger,
        ok: true,
        slotId,
        selectedSwipeId: slot.selectedSwipeId,
        checkpoint: deepClone(slot.checkpoint),
        restoreState: deepClone(slot.checkpoint),
        state: deepClone(slot.checkpoint),
        checkpointCt: slot.checkpointCt,
        checkpointHead: slot.checkpointHead,
    };
}

/** Select and return a rebaseline-ready snapshot for the chosen swipe. */
export function rebaselineSelectedSwipe(input, options = {}) {
    const selected = selectAssistantSwipe(input, options);
    if (!selected.ok) return selected;
    return {
        ...selected,
        rebaseline: true,
        restoreState: deepClone(selected.checkpoint),
        state: deepClone(selected.checkpoint),
    };
}

export class BranchLedger {
    constructor(input = {}, options = {}) { this._ledger = normalizeBranchLedger(input, options); }
    snapshot() { return deepClone(this._ledger); }
    get(slotId) { return deepClone(this._ledger.slots[text(slotId)] ?? null); }
    checkpoint(options = {}) { const result = checkpointAssistantSlot(this._ledger, options); this._ledger = result.ledger; return result; }
    registerSwipe(options = {}) { const result = registerAssistantSwipe(this._ledger, options); this._ledger = result.ledger; return result; }
    selectSwipe(options = {}) { const result = selectAssistantSwipe(this._ledger, options); this._ledger = result.ledger; return result; }
    prepareSwipeEvaluation(options = {}) { return this.selectSwipe(options); }
    rebaselineSelectedSwipe(options = {}) { const result = rebaselineSelectedSwipe(this._ledger, options); this._ledger = result.ledger; return result; }
    restoreCheckpoint(options = {}) { const result = restoreAssistantCheckpoint(this._ledger, options); this._ledger = result.ledger; return result; }
    invalidateSwipe(options = {}) { const result = invalidateAssistantSwipe(this._ledger, options); this._ledger = result.ledger; return result; }
    invalidateEdit(options = {}) { const result = invalidateAssistantEdit(this._ledger, options); this._ledger = result.ledger; return result; }
    invalidateDelete(options = {}) { const result = invalidateAssistantDelete(this._ledger, options); this._ledger = result.ledger; return result; }
    toJSON() { return this.snapshot(); }
}

export const BranchManager = BranchLedger;
export function createBranchManager(input = {}, options = {}) { return new BranchLedger(input, options); }
