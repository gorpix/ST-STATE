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

test('all supported legacy actor and scene labels normalize to canonical fields', () => {
    const before = state();
    const patch = { version: 2, base: before.head, mode: 'NORMAL', tx: 'legacy-vad', ops: [
        { op: 'actor.set', id: 'AL', set: { vad: '+2/+1/-1', doing: 'settling' } },
    ] };
    const validated = validatePatchEnvelope(patch, { state: before });
    assert.equal(validated.ok, true);
    assert.deepEqual(validated.value.ops[0].set, { valence: 2, arousal: 1, dominance: -1, doing: 'settling' });

    const result = applyTransaction(before, patch, { messageIdentity: 'legacy-vad-message', now: 2 });
    assert.equal(result.status, 'committed');
    assert.equal(result.state.actors.AL.valence, 2);
    assert.equal(result.state.actors.AL.arousal, 1);
    assert.equal(result.state.actors.AL.dominance, -1);

    for (const VAD of ['1,0,-2', '[1/0/-2]', '1 | 0 | -2', '1 0 -2', [1, 0, -2]]) {
        const uppercase = validatePatchEnvelope({ version: 2, base: before.head, mode: 'NORMAL', ops: [
            { op: 'actor.set', id: 'AL', set: { VAD } },
        ] }, { state: before });
        assert.equal(uppercase.ok, true);
        assert.deepEqual(uppercase.value.ops[0].set, { valence: 1, arousal: 0, dominance: -2 });
    }

    const sceneAlias = validatePatchEnvelope({ version: 2, base: before.head, mode: 'NORMAL', ops: [
        { op: 'actor.set', id: 'AL', set: {
            At: 'window', Doing: 'watching', Agenda: 'wait', Focus: 'rain', Aware: 'room',
            Fibs: 'None', Circle: 'Bob', Body: 'well', 'Agenda Step': '1', agenda_max: '3',
        } },
        { op: 'scene.set', set: {
            Spotlight: 'Alice', 'Open Beat': 'The latch turns', time_pressure: 'None', Env: 'Rain against the windows',
            Positions: { AL: 'window' }, Time: '22:00',
        } },
    ] }, { state: before });
    assert.equal(sceneAlias.ok, true);
    assert.deepEqual(sceneAlias.value.ops[0].set, {
        at: 'window', doing: 'watching', agenda: 'wait', focus: 'rain', aware: 'room', fibs: 'None', circle: 'Bob', body: 'well',
        agendaStep: 1, agendaMax: 3,
    });
    assert.deepEqual(sceneAlias.value.ops[1].set, {
        spotlight: 'Alice', openBeat: 'The latch turns', timePressure: 'None', environment: 'Rain against the windows',
        positions: { AL: 'window' }, time: '22:00',
    });

    const legacyPositions = validatePatchEnvelope({ version: 2, base: before.head, mode: 'NORMAL', ops: [
        { op: 'scene.set', set: { Positions: 'User beside Alice; Alice at the window; loose coat on floor' } },
    ] }, { state: before });
    assert.equal(legacyPositions.ok, true);
    assert.deepEqual(legacyPositions.value.ops[0].set.positions, { US: 'beside Alice', AL: 'at the window' });
});

test('bootstrap actor.create is idempotent and legacy fullname maps to displayName', () => {
    const before = state();
    before.actors.NS = { id: 'NS', name: 'Nicholas Snickerson' };
    const patch = { version: 2, base: before.head, mode: 'NORMAL', tx: 'bootstrap-upsert', ops: [
        { op: 'actor.create', id: 'NS', actor: { name: 'Nick', fullname: 'Nicholas Snickerson', at: 'his bed', vad: '1,1,1' } },
    ] };

    const validated = validatePatchEnvelope(patch, { state: before });
    assert.equal(validated.ok, true);
    assert.deepEqual(validated.value.ops[0], {
        op: 'actor.set',
        id: 'NS',
        set: { name: 'Nick', displayName: 'Nicholas Snickerson', at: 'his bed', valence: 1, arousal: 1, dominance: 1 },
    });

    const committed = applyTransaction(before, patch, { messageIdentity: 'bootstrap-upsert-message', now: 2 });
    assert.equal(committed.status, 'committed');
    assert.equal(committed.state.ct, 1);
    assert.equal(committed.state.actors.NS.name, 'Nick');
    assert.equal(committed.state.actors.NS.displayName, 'Nicholas Snickerson');
});

test('legacy vad compatibility remains strict and unambiguous', () => {
    const before = state();
    for (const vad of ['+2/+1', '+2/hot/-1', '+3/+1/-1', '+2/+1,-1']) {
        const result = validatePatchEnvelope({ version: 2, base: before.head, mode: 'NORMAL', ops: [
            { op: 'actor.set', id: 'AL', field: 'vad', value: vad },
        ] }, { state: before });
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((error) => /legacy vad/.test(error)));
    }
    const mixed = validatePatchEnvelope({ version: 2, base: before.head, mode: 'NORMAL', ops: [
        { op: 'actor.set', id: 'AL', set: { vad: '+2/+1/-1', valence: 0 } },
    ] }, { state: before });
    assert.equal(mixed.ok, false);
    assert.ok(mixed.errors.some((error) => /cannot be combined/.test(error)));
    const duplicateAlias = validatePatchEnvelope({ version: 2, base: before.head, mode: 'NORMAL', ops: [
        { op: 'actor.set', id: 'AL', set: { vad: '+2/+1/-1', VAD: '+1/0/-2' } },
    ] }, { state: before });
    assert.equal(duplicateAlias.ok, false);
    assert.ok(duplicateAlias.errors.some((error) => /same canonical field "vad"/.test(error)));
    const duplicateEnvironment = validatePatchEnvelope({ version: 2, base: before.head, mode: 'NORMAL', ops: [
        { op: 'scene.set', set: { env: 'rain', environment: 'sun' } },
    ] }, { state: before });
    assert.equal(duplicateEnvironment.ok, false);
    assert.ok(duplicateEnvironment.errors.some((error) => /same canonical field "environment"/.test(error)));
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

test('relation updates validate ranges and commit atomically', () => {
    const before = state();
    const patch = { version: 2, base: before.head, mode: 'NORMAL', tx: 'relation-turn', ops: [
        { op: 'relation.set', a: 'US', b: 'AL', set: { Bond: '5', Sparks: 3, Grudge: 1 } },
    ] };
    const validated = validatePatchEnvelope(patch, { state: before });
    assert.equal(validated.ok, true);
    assert.deepEqual(validated.value.ops[0], { op: 'relation.set', a: 'US', b: 'AL', set: { bond: 5, sparks: 3, grudge: 1 } });
    const committed = applyTransaction(before, patch, { messageIdentity: 'relation-message', now: 2 });
    assert.equal(committed.status, 'committed');
    assert.deepEqual(committed.state.relations.pairs['US|AL'], { ...before.relations.pairs['US|AL'], bond: 5, sparks: 3, grudge: 1 });
    const badRange = validatePatchEnvelope({ ...patch, ops: [{ op: 'relation.set', a: 'US', b: 'AL', field: 'bond', value: 21 }] }, { state: before });
    assert.equal(badRange.ok, false);
    assert.ok(badRange.errors.some((error) => /-5 through 20/.test(error)));
    const unknownActor = validatePatchEnvelope({ ...patch, ops: [{ op: 'relation.set', a: 'US', b: 'ZZ', field: 'bond', value: 1 }] }, { state: before });
    assert.equal(unknownActor.ok, false);
    assert.ok(unknownActor.errors.some((error) => /actor does not exist/.test(error)));
});

test('legacy prose scene positions resolve known names and ignore object clauses', () => {
    const before = state();
    before.actors.US.name = 'Janko';
    before.actors.NI = { id: 'NI', name: 'Nick' };
    const result = validatePatchEnvelope({ version: 2, base: before.head, mode: 'NORMAL', ops: [
        { op: 'scene.set', set: { positions: "Janko pressed to Nick's side by the monitor box, paw on his ass; Nick shirtless, arm around Janko's neck; tank top on floor; Richard the Great on desk" } },
    ] }, { state: before });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.ops[0].set.positions, {
        US: "pressed to Nick's side by the monitor box, paw on his ass",
        NI: "shirtless, arm around Janko's neck",
    });

    before.actors.US.name = 'Janko Makar (wolf)';
    before.actors.NI.name = 'Nick Snickerson';
    const shortNames = validatePatchEnvelope({ version: 2, base: before.head, mode: 'NORMAL', ops: [
        { op: 'scene.set', set: { positions: "Nick on back on Janko's bed (gear on floor), Janko over him, nose at waistband; desk item nearby" } },
    ] }, { state: before });
    assert.equal(shortNames.ok, true);
    assert.deepEqual(shortNames.value.ops[0].set.positions, {
        NI: "on back on Janko's bed (gear on floor)",
        US: 'over him, nose at waistband',
    });
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


