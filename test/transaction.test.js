import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from '../src/schema.js';
import { applyDiff, applyTransaction } from '../src/reducer.js';
import { validatePatchEnvelope } from '../src/validation.js';
import { deepEqual } from '../src/util.js';

function state() {
    const value = createEmptyState({ now: 1 });
    value.actors = { US: { id: 'US', name: 'User' }, AL: { id: 'AL', name: 'Alice', at: 'room' } };
    value.scene.positions = { AL: 'room' };
    value.relations.pairs['US|AL'] = { a: 'US', b: 'AL', labelA: 'User', labelB: 'Alice', bond: 3, sparks: 1, grudge: 0 };
    return value;
}

test('strict validation rejects arbitrary paths, unknown ops, bad ranges and IDs', () => {
    const result = validatePatchEnvelope({ version: 2, base: 'GENESIS', mode: 'NORMAL', ops: [{ op: 'state.set', path: 'actors.AL.name', value: 'x' }] }, { state: state() });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /unknown operation/.test(error)));
    const badActor = validatePatchEnvelope({ version: 2, base: 'GENESIS', mode: 'NORMAL', ops: [{ op: 'actor.set', id: 'A', field: 'valence', value: 4 }] }, { state: state() });
    assert.equal(badActor.ok, false);
    const identityMutation = validatePatchEnvelope({ version: 2, base: 'GENESIS', mode: 'NORMAL', ops: [{ op: 'actor.set', id: 'AL', field: 'id', value: 'BO' }] }, { state: state() });
    assert.equal(identityMutation.ok, false);
    assert.ok(identityMutation.errors.some((error) => /not allowlisted/.test(error)));
});

test('NORMAL actor/scene operations commit atomically and increment ct once', () => {
    const before = state();
    const patch = { version: 2, base: before.head, mode: 'NORMAL', tx: 'turn-1', ops: [
        { op: 'actor.set', id: 'AL', set: { name: 'Alice Prime', position: 'door' } },
        { op: 'actor.create', id: 'BO', actor: { name: 'Bob', at: 'room' } },
        { op: 'scene.set', set: { openBeat: 'The latch turns', positions: { AL: 'door', BO: 'room' } } },
    ] };
    const result = applyTransaction(before, patch, { messageIdentity: 'message-1', now: 2 });
    assert.equal(result.status, 'committed');
    assert.equal(result.state.ct, 1);
    assert.equal(result.state.actors.AL.name, 'Alice Prime');
    assert.equal(result.state.actors.BO.name, 'Bob');
    assert.equal(result.state.scene.openBeat, 'The latch turns');
    assert.equal(result.state.history.length, 1);
    assert.equal(result.diff.forward.length > 0, true);
    const reverted = applyDiff(result.state, result.diff.inverse);
    // History/dedupe are intentionally not part of the inverse application; the
    // canonical fields changed by this transaction must be reversible.
    assert.equal(reverted.ct, before.ct);
    assert.equal(reverted.actors.AL.name, before.actors.AL.name);
    assert.equal(reverted.scene.openBeat, before.scene.openBeat);
});

test('stale base and duplicate transaction do not mutate state', () => {
    const before = state();
    const patch = { version: 2, base: before.head, mode: 'NORMAL', tx: 'same', ops: [{ op: 'scene.set', set: { openBeat: 'x' } }] };
    const committed = applyTransaction(before, patch, { messageIdentity: 'm', now: 2 });
    const duplicate = applyTransaction(committed.state, patch, { messageIdentity: 'm', now: 3 });
    assert.equal(duplicate.status, 'duplicate');
    assert.ok(deepEqual(duplicate.state, committed.state));
    const stale = applyTransaction(committed.state, { ...patch, tx: 'new', base: 'GENESIS' }, { messageIdentity: 'm2', now: 3 });
    assert.equal(stale.status, 'stale');
    assert.ok(deepEqual(stale.state, committed.state));
});

test('OOC, FLASH, and flash handoff never mutate, roll, increment, or add history', () => {
    const before = state();
    for (const mode of ['OOC', 'FLASH']) {
        const result = applyTransaction(before, { version: 2, base: before.head, mode, ops: [{ op: 'scene.set', set: { openBeat: 'must not apply' } }] }, { now: 2 });
        assert.equal(result.status, 'ignored');
        assert.ok(deepEqual(result.state, before));
    }
    const frozen = applyTransaction(before, { version: 2, base: before.head, mode: 'NORMAL', ops: [{ op: 'scene.set', set: { openBeat: 'must not apply' } }] }, { flashHandoff: true, now: 2 });
    assert.equal(frozen.reason, 'flash_handoff');
    assert.ok(deepEqual(frozen.state, before));
});


