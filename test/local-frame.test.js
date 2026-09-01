import test from 'node:test';
import assert from 'node:assert/strict';
import { exportLegacyState } from '../src/legacy.js';
import { buildUnifiedLocalFrame, formatUnifiedLocalFrame, projectUnifiedLocalFrame } from '../src/local-frame.js';
import { createEmptyState } from '../src/schema.js';
import { deepClone } from '../src/util.js';

function representativeState() {
    const state = createEmptyState({ now: 1 });
    state.ct = 14;
    state.head = 'head-14';
    state.meta.ct = 14;
    state.meta.head = 'head-14';
    state.scene = {
        spotlight: ['Alice'],
        openBeat: 'Alice waits for an answer',
        timePressure: 'The train leaves in ten minutes',
        environment: 'A rain-streaked station platform',
        positions: { AL: 'beneath the platform clock', BO: 'beside the ticket machine' },
        time: '23:50',
    };
    state.actors = {
        BO: { id: 'BO', name: 'Bob', at: 'old duplicated position', doing: 'checking the timetable', valence: -1, arousal: 1, dominance: 0 },
        AL: { id: 'AL', name: 'Alice', displayName: 'Alice Vale', location: 'old location', position: 'old position', activity: 'watching Bob', agenda: 'Get aboard', focus: ['Bob', 'last train'] },
    };
    state.thoughts = [
        { actor: 'Alice Vale', thoughts: 'He is going to miss it.' },
        { actor: 'Unknown observer', thoughts: 'They look nervous.' },
    ];
    state.residue = [
        { subject: 'AL', event: 'Bob hesitated', meaning: 'He may stay', aftereffect: 'Hope', cue: 'His hand near hers' },
        { subject: 'The station', event: 'The lights flickered', meaning: 'Something is wrong' },
    ];
    state.relations.pairs = {
        'BO|AL': { a: 'BO', b: 'AL', bond: 4, sparks: 18, grudge: 0 },
    };
    return state;
}

test('Unified Local Frame folds position, thoughts, and residue into one actor record', () => {
    const frame = projectUnifiedLocalFrame(representativeState());
    const alice = frame.actors.find((actor) => actor.id === 'AL');
    assert.equal(alice.position, 'beneath the platform clock');
    assert.equal(alice.state.activity, 'watching Bob');
    assert.deepEqual(alice.thoughts, ['He is going to miss it.']);
    assert.match(alice.residue[0].id, /^r-/);
    const { id: _residueId, ...aliceResidue } = alice.residue[0];
    assert.deepEqual(aliceResidue, { event: 'Bob hesitated', meaning: 'He may stay', aftereffect: 'Hope', cue: 'His hand near hers' });
    assert.equal(Object.hasOwn(alice, 'location'), false);
    assert.equal(Object.hasOwn(alice, 'at'), false);
    assert.equal(frame.world.environment, 'A rain-streaked station platform');
    assert.equal(frame.unassignedThoughts[0].actor, 'Unknown observer');
    assert.equal(frame.unassignedResidue[0].subject, 'The station');
});

test('Unified Local Frame does not guess ambiguous actor aliases', () => {
    const state = representativeState();
    state.actors.CA = { id: 'CA', name: 'Alice' };
    state.thoughts.push({ actor: 'Alice', thoughts: 'Ambiguous thought' });
    const frame = projectUnifiedLocalFrame(state);
    assert.equal(frame.actors.some((actor) => actor.thoughts?.includes('Ambiguous thought')), false);
    assert.equal(frame.unassignedThoughts.some((item) => item.thoughts === 'Ambiguous thought'), true);
});

test('Unified Local Frame supports a selected actor subset without dropping detached material', () => {
    const frame = projectUnifiedLocalFrame(representativeState(), { selectedActorIds: ['Alice'] });
    assert.deepEqual(frame.actors.map((actor) => actor.id), ['AL']);
    assert.equal(frame.relations.length, 1);
    assert.equal(frame.unassignedThoughts.some((item) => item.actor === 'Unknown observer'), true);
});

test('Unified Local Frame is deterministic, sanitized, and does not mutate canonical input', () => {
    const first = representativeState();
    first.actors.AL.focus.push('<script>bad()</script>safe\u0000');
    const before = deepClone(first);
    const second = representativeState();
    second.actors = { AL: second.actors.AL, BO: second.actors.BO };
    second.relations.pairs = { 'BO|AL': second.relations.pairs['BO|AL'] };
    second.actors.AL.focus.push('<script>bad()</script>safe\u0000');
    const left = buildUnifiedLocalFrame(first);
    const right = buildUnifiedLocalFrame(second);
    assert.equal(left, right);
    assert.doesNotMatch(left, /<script>|\u0000/);
    assert.match(left, /bad\(\)safe/);
    assert.deepEqual(first, before);
});

test('Unified Local Frame transport has one placement and is smaller than expanded legacy state', () => {
    const state = representativeState();
    const frame = projectUnifiedLocalFrame(state);
    const output = formatUnifiedLocalFrame(frame);
    const legacy = exportLegacyState(state);
    assert.equal(output.match(/beneath the platform clock/g)?.length, 1);
    assert.equal(output.match(/He is going to miss it\./g)?.length, 1);
    assert.equal(output.match(/Bob hesitated/g)?.length, 1);
    assert.ok(output.length < legacy.length * 0.75, `expected ${output.length} to be < 75% of ${legacy.length}`);
});
