import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHiddenPatch, removeControlPayload, hasFlashHandoff } from '../src/patch.js';

test('extracts hidden patch while preserving prose and removes only control payload', () => {
    const text = 'A reply.\n<!--ST_PATCH {"version":2,"base":"h","mode":"OOC","ops":[]} -->\nEnd.';
    const result = extractHiddenPatch(text);
    assert.equal(result.ok, true);
    assert.equal(result.patch.mode, 'OOC');
    assert.equal(result.prose, 'A reply.\n\nEnd.');
    assert.equal(result.comments.length, 1);
});

test('reports malformed patch but still hides its well-formed comment', () => {
    const text = 'Prose <!--ST_PATCH {not json} --> tail';
    const result = extractHiddenPatch(text);
    assert.equal(result.found, true);
    assert.equal(result.ok, false);
    assert.match(result.error, /JSON|Unexpected|object/i);
    assert.equal(result.prose, 'Prose  tail');
});

test('parses line patches without JSON escaping and preserves pipes and quotes in values', () => {
    const text = `Reply.\n<!--ST_PATCH\nV2\nbase=h-4\nmode=NORMAL\ntx=turn-5\nactor.set|AL|body|Alice said "yes" | still calm\nactor.set|AL|valence|2\nscene.set|openBeat|The sign reads "GO" | the door opens\nscene.position|AL|beside the door\n-->`;
    const result = extractHiddenPatch(text);
    assert.equal(result.ok, true);
    assert.equal(result.patch.base, 'h-4');
    assert.equal(result.patch.ops[0].set.body, 'Alice said "yes" | still calm');
    assert.equal(result.patch.ops[0].set.valence, 2);
    assert.equal(result.patch.ops[1].set.openBeat, 'The sign reads "GO" | the door opens');
    assert.equal(result.patch.ops[1].set.positions.AL, 'beside the door');
    assert.equal(result.prose, 'Reply.\n');
});

test('parses and groups line-based relationship updates', () => {
    const text = `<!--ST_PATCH\nV2\nbase=h-4\nmode=NORMAL\ntx=turn-5\nrelation.set|US|AL|bond|4\nrelation.set|US|AL|sparks|2\nrelation.set|US|AL|grudge|1\n-->`;
    const result = extractHiddenPatch(text);
    assert.equal(result.ok, true);
    assert.deepEqual(result.patch.ops, [{ op: 'relation.set', a: 'US', b: 'AL', set: { bond: 4, sparks: 2, grudge: 1 } }]);
});

test('flash handoff freezes and is removed from display', () => {
    assert.equal(hasFlashHandoff('ordinary <flash_handoff reason="zoom"/> prose'), true);
    assert.equal(removeControlPayload('ordinary <flash_handoff reason="zoom"/> prose'), 'ordinary  prose');
});

test('dangling patch comment is treated as control payload and removed to end of message', () => {
    const source = 'visible prose <!-- ST_PATCH {"version":2';
    const extracted = extractHiddenPatch(source);
    assert.equal(extracted.found, false);
    assert.equal(extracted.controlBearing, true);
    assert.equal(extracted.prose, 'visible prose ');
});


