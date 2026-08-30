import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from '../src/schema.js';
import {
    BranchLedger,
    checkpointAssistantSlot,
    createBranchLedger,
    invalidateAssistantDelete,
    invalidateAssistantEdit,
    normalizeBranchLedger,
    recordAssistantSwipeResult,
    selectAssistantSwipe,
    stableSwipeIdentity,
} from '../src/branch.js';

function state() {
    const value = createEmptyState({ now: 1 });
    value.ct = 4;
    value.meta.ct = 4;
    value.head = 'h-4';
    value.meta.head = 'h-4';
    value.scene.openBeat = 'before response';
    return value;
}

test('swipe identities are stable and content-independent', () => {
    assert.equal(stableSwipeIdentity({ messageId: 'm1', swipeIndex: 2 }), 'swipe:slot:m1:index:2');
    assert.equal(stableSwipeIdentity({ messageId: 'm1', swipeId: 'provider-id', swipeIndex: 2 }), 'swipe:slot:m1:id:provider-id');
});

test('checkpoint is captured once and selecting a different swipe returns the same pre-slot state', () => {
    const before = state();
    let ledger = createBranchLedger({ maxHistory: 5 });
    const first = checkpointAssistantSlot(ledger, { messageId: 'm1', index: 7, state: before, swipeIndex: 0, at: 10 });
    ledger = first.ledger;
    const changed = structuredClone(before);
    changed.ct = 5;
    changed.head = 'h-5';
    const second = selectAssistantSwipe(ledger, { messageId: 'm1', swipeIndex: 1, at: 11 });
    assert.equal(second.ok, true);
    assert.equal(second.requiresRebaseline, true);
    assert.equal(second.selectedSwipeIndex, 1);
    assert.equal(second.checkpointCt, 4);
    assert.equal(second.checkpointHead, 'h-4');
    assert.deepEqual(second.checkpoint.scene.openBeat, 'before response');
    assert.notEqual(second.checkpoint, changed);
    assert.equal(second.ledger.slots['slot:m1'].selectedSwipeIndex, 1);
});

test('Native swipe results retain a bounded replay diff', () => {
    const before = state();
    let ledger = checkpointAssistantSlot(createBranchLedger(), { messageId: 'native', state: before, swipeIndex: 0 }).ledger;
    const after = structuredClone(before);
    after.ct = 5; after.head = 'h-5'; after.scene.openBeat = 'after response';
    const recorded = recordAssistantSwipeResult(ledger, {
        messageId: 'native', swipeIndex: 0, mode: 'NATIVE', state: after,
        diff: [{ path: 'ct', before: 4, after: 5 }, { path: 'head', before: 'h-4', after: 'h-5' }],
    });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.swipe.commitMode, 'NATIVE');
    assert.equal(recorded.swipe.commitCt, 5);
    assert.equal(recorded.swipe.commitHead, 'h-5');
    assert.equal(recorded.swipe.diff.length, 2);
});

test('edit and delete invalidation do not alter checkpoint or canonical ct', () => {
    let ledger = checkpointAssistantSlot(createBranchLedger(), { messageId: 'm2', state: state(), swipeIndex: 0 }).ledger;
    ledger = selectAssistantSwipe(ledger, { messageId: 'm2', swipeIndex: 1 }).ledger;
    const edited = invalidateAssistantEdit(ledger, { messageId: 'm2', reason: 'text changed', at: 20 });
    assert.equal(edited.ok, true);
    assert.equal(edited.ledger.slots['slot:m2'].status, 'edited');
    assert.equal(edited.ledger.slots['slot:m2'].checkpointCt, 4);
    assert.equal(edited.ledger.events.at(-1).kind, 'invalidate_edit');
    const deleted = invalidateAssistantDelete(edited.ledger, { messageId: 'm2', at: 21 });
    assert.equal(deleted.ledger.slots['slot:m2'].status, 'deleted');
    assert.equal(deleted.ledger.slots['slot:m2'].selectedSwipeId, null);
    assert.equal(deleted.ledger.slots['slot:m2'].checkpointCt, 4);
});

test('history is bounded and snapshots are deep clones', () => {
    let ledger = createBranchLedger({ maxHistory: 2 });
    const before = state();
    ledger = checkpointAssistantSlot(ledger, { messageId: 'm3', state: before, at: 1 }).ledger;
    ledger = selectAssistantSwipe(ledger, { messageId: 'm3', swipeIndex: 1, at: 2 }).ledger;
    ledger = selectAssistantSwipe(ledger, { messageId: 'm3', swipeIndex: 2, at: 3 }).ledger;
    assert.equal(ledger.events.length, 2);
    const normalized = normalizeBranchLedger(ledger, { maxHistory: 2 });
    normalized.slots['slot:m3'].checkpoint.scene.openBeat = 'mutated';
    assert.equal(ledger.slots['slot:m3'].checkpoint.scene.openBeat, 'before response');
    const manager = new BranchLedger(ledger);
    const copy = manager.snapshot();
    copy.slots['slot:m3'].checkpointCt = 99;
    assert.equal(manager.get('slot:m3').checkpointCt, 4);
});

test('full-state checkpoints retain only the newest bounded assistant slots', () => {
    let ledger = createBranchLedger({ maxSlots: 2 });
    for (let index = 0; index < 4; index += 1) {
        ledger = checkpointAssistantSlot(ledger, { slotId: `slot:${index}`, messageId: `m${index}`, index, state: state(), at: index }).ledger;
    }
    assert.deepEqual(Object.keys(ledger.slots).sort(), ['slot:2', 'slot:3']);
});

test('replaying an identical host event is idempotent by deterministic event ID', () => {
    const before = state();
    let ledger = checkpointAssistantSlot(createBranchLedger(), { messageId: 'm4', state: before, swipeIndex: 0, at: 1 }).ledger;
    ledger = checkpointAssistantSlot(ledger, { messageId: 'm4', state: before, swipeIndex: 0, at: 999 }).ledger;
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.slots['slot:m4'].history.length, 1);
});
