import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHiddenPatch, removeControlPayload, hasFlashHandoff } from '../src/patch.js';

test('extracts hidden patch while preserving prose and removes only control payload', () => {
    const text = 'A reply.\n<!--FF5_PATCH {"version":2,"base":"h","mode":"OOC","ops":[]} -->\nEnd.';
    const result = extractHiddenPatch(text);
    assert.equal(result.ok, true);
    assert.equal(result.patch.mode, 'OOC');
    assert.equal(result.prose, 'A reply.\n\nEnd.');
    assert.equal(result.comments.length, 1);
});

test('reports malformed patch but still hides its well-formed comment', () => {
    const text = 'Prose <!--FF5_PATCH {not json} --> tail';
    const result = extractHiddenPatch(text);
    assert.equal(result.found, true);
    assert.equal(result.ok, false);
    assert.match(result.error, /JSON|Unexpected|object/i);
    assert.equal(result.prose, 'Prose  tail');
});

test('flash handoff freezes and is removed from display', () => {
    assert.equal(hasFlashHandoff('ordinary <flash_handoff reason="zoom"/> prose'), true);
    assert.equal(removeControlPayload('ordinary <flash_handoff reason="zoom"/> prose'), 'ordinary  prose');
});


