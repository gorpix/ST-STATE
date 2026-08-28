import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from '../src/schema.js';
import { compareShadowParity, makeShadowSidecar, shadowClaimedPaths, shadowHandshake } from '../src/shadow.js';

test('shadow parity compares actor aliases, scene references, and ct only', () => {
    const authoritative = createEmptyState({ now: 1 });
    authoritative.ct = 4; authoritative.meta.ct = 4;
    authoritative.actors = { AL: { id: 'AL', name: 'Alice', at: 'lantern room', doing: 'guarding' } };
    authoritative.scene = { spotlight: ['Alice'], openBeat: 'wait', timePressure: 'rain', environment: 'wet brass', positions: { AL: 'lantern room' }, time: '' };
    const candidate = createEmptyState({ now: 2 });
    candidate.ct = 4; candidate.meta.ct = 4;
    candidate.actors = { AL: { id: 'AL', name: 'Alice', location: 'lantern room', activity: 'guarding' } };
    candidate.scene = { spotlight: ['AL'], openBeat: 'wait', timePressure: 'rain', environment: 'wet brass', positions: { AL: 'lantern room' }, time: '' };
    candidate.factions = { Guild: { goal: 'changed cold domain' } };
    const report = compareShadowParity(authoritative, candidate);
    assert.equal(report.status, 'match');
    assert.deepEqual(report.mismatches, []);
    assert.ok(report.unsupportedDomains.includes('factions'));
});

test('shadow parity marks supported divergence without treating cold domains as failures', () => {
    const authoritative = createEmptyState({ now: 1 });
    authoritative.ct = 4; authoritative.meta.ct = 4; authoritative.scene.openBeat = 'old';
    const candidate = createEmptyState({ now: 2 });
    candidate.ct = 5; candidate.meta.ct = 5; candidate.scene.openBeat = 'new';
    const report = compareShadowParity(authoritative, candidate, { patchStatus: 'stale' });
    assert.equal(report.status, 'diverged');
    assert.equal(report.patchStatus, 'stale');
    assert.ok(report.mismatches.some((item) => item.path === 'ct'));
    assert.ok(report.mismatches.some((item) => item.path === 'scene.openBeat'));
    assert.equal(report.unsupported.length > 0, true);
    const sidecar = makeShadowSidecar(report, { transactionId: 'x', messageId: 'm' });
    assert.equal(sidecar.transactionId, 'x');
    assert.equal(sidecar.messageId, 'm');
    assert.equal(sidecar.candidateState, undefined);
});

test('delta parity compares only candidate-claimed paths and their aliases', () => {
    const before = createEmptyState({ now: 1 });
    before.actors.AL = { id: 'AL', name: 'Alice', doing: 'waiting', focus: 'door' };
    const authoritative = structuredClone(before);
    authoritative.ct = 1;
    authoritative.actors.AL.doing = 'opening the door';
    authoritative.actors.AL.focus = 'hallway paraphrased by legacy';
    const candidate = structuredClone(before);
    candidate.ct = 1;
    candidate.actors.AL.doing = 'opening the door';
    const patch = { ops: [{ op: 'actor.set', id: 'AL', set: { doing: 'opening the door' } }] };
    const paths = shadowClaimedPaths(patch);
    assert.deepEqual(paths, ['actors.AL.activity', 'ct']);
    const report = compareShadowParity(authoritative, candidate, { patch });
    assert.equal(report.status, 'match');
    assert.deepEqual(report.supportedPaths, paths);
    assert.doesNotMatch(JSON.stringify(report), /focus/);
});

test('relationship claims participate in Shadow parity', () => {
    const authoritative = createEmptyState({ now: 1 });
    authoritative.ct = 1; authoritative.meta.ct = 1;
    authoritative.relations.pairs['US|AL'] = { a: 'US', b: 'AL', bond: 5, sparks: 2, grudge: 0 };
    const candidate = structuredClone(authoritative);
    candidate.relations.pairs['US|AL'].bond = 4;
    const patch = { ops: [{ op: 'relation.set', a: 'US', b: 'AL', set: { bond: 4 } }] };
    const paths = shadowClaimedPaths(patch);
    assert.deepEqual(paths, ['ct', 'relations.pairs.US|AL.bond']);
    const report = compareShadowParity(authoritative, candidate, { patch });
    assert.equal(report.status, 'diverged');
    assert.deepEqual(report.mismatches, [{ path: 'relations.pairs.US|AL.bond', expected: 5, actual: 4 }]);
    assert.ok(report.supportedRoots.includes('relations'));
    assert.ok(!report.unsupportedDomains.includes('relations'));
});

test('legacy punctuation variants match while changed words still diverge', () => {
    const authoritative = createEmptyState({ now: 1 });
    authoritative.ct = 2; authoritative.meta.ct = 2;
    authoritative.scene.openBeat = 'session-2 — door-check';
    authoritative.scene.positions = { AL: 'center-floor' };
    const candidate = structuredClone(authoritative);
    candidate.scene.openBeat = 'Session 2 - door check';
    candidate.scene.positions.AL = 'center floor';
    const patch = { ops: [{ op: 'scene.set', set: { openBeat: candidate.scene.openBeat, positions: candidate.scene.positions } }] };
    const paths = shadowClaimedPaths(patch);
    assert.deepEqual(paths, ['ct', 'scene.openBeat', 'scene.positions.AL']);
    assert.equal(compareShadowParity(authoritative, candidate, { patch }).status, 'match');
    candidate.scene.openBeat = 'session 2 window check';
    const report = compareShadowParity(authoritative, candidate, { patch });
    assert.equal(report.status, 'diverged');
    assert.deepEqual(report.mismatches.map((item) => item.path), ['scene.openBeat']);
});

test('shadow handshake exposes the evaluator contract and exact control markers', () => {
    const state = createEmptyState({ now: 1 });
    const text = shadowHandshake(state);
    assert.equal(text, [
        'ST_STATE_HANDSHAKE v1',
        'contract=3',
        'schema=2',
        'mode=SHADOW',
        'preset=ST-ENDGAME',
        'legacy=internal_states',
        'patch=ST_PATCH',
        'flash=flash_handoff',
        'stateCt=0',
        'stateHead=GENESIS',
        'features=actor,scene,relation',
        'END_ST_STATE_HANDSHAKE',
    ].join('\n'));
});
