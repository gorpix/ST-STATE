import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePlainText } from '../src/util.js';
import { validatePatchEnvelope } from '../src/validation.js';
import { createEmptyState } from '../src/schema.js';

test('imported/model strings cannot carry markup or control bytes into state', () => {
    assert.equal(sanitizePlainText('<script>alert(1)</script><b>Alice</b>\u0000'), 'alert(1)Alice');
    const state = createEmptyState(); state.actors = { AL: { id: 'AL', name: 'Alice' } };
    const patch = validatePatchEnvelope({ version: 2, base: state.head, mode: 'NORMAL', ops: [{ op: 'actor.set', id: 'AL', field: 'name', value: '<img src=x onerror=alert(1)>Safe' }] }, { state });
    assert.equal(patch.ok, true);
    assert.equal(patch.value.ops[0].set.name, 'Safe');
});


