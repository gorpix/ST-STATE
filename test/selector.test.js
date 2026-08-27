import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from '../src/schema.js';
import { selectHotState, buildHotStatePack, buildProtocolPrompt } from '../src/selector.js';

test('hot selector includes exact mentions, spotlight/on-screen actors, and direct relations only', () => {
    const state = createEmptyState({ now: 1 });
    state.actors = {
        US: { id: 'US', name: 'User' },
        AL: { id: 'AL', name: 'Alice', at: 'room' },
        BO: { id: 'BO', name: 'Bob', at: 'room' },
        CA: { id: 'CA', name: 'Carol', at: 'far away' },
        DE: { id: 'DE', name: 'Derek', at: 'far away' },
    };
    state.scene.spotlight = ['AL'];
    state.scene.positions = { AL: 'room', BO: 'room' };
    state.relations.pairs = {
        'AL|BO': { a: 'AL', b: 'BO', bond: 4, sparks: 0, grudge: 0 },
        'BO|CA': { a: 'BO', b: 'CA', bond: 2, sparks: 0, grudge: 0 },
        'CA|DE': { a: 'CA', b: 'DE', bond: 2, sparks: 0, grudge: 0 },
    };
    const selected = selectHotState(state, { userText: 'Alice asks about the lantern.' });
    assert.deepEqual(selected.selectedActorIds.sort(), ['AL', 'BO', 'US'].sort());
    assert.deepEqual(selected.selectedRelationKeys.sort(), ['AL|BO', 'BO|CA'].sort());
    assert.ok(selected.coldActorIds.includes('CA'));
    const pack = buildHotStatePack(state, { userText: 'Alice asks about the lantern.' });
    assert.match(pack, /ST_STATE_PACK v2/);
    assert.match(pack, /ACTOR/);
    assert.doesNotMatch(pack, /Carol/);
});

test('protocol keeps an ordinary zero-delta RP turn NORMAL', () => {
    const prompt = buildProtocolPrompt(createEmptyState({ now: 1 })).text;
    assert.match(prompt, /Ordinary RP always uses NORMAL, even when ops:\[\]/);
    assert.match(prompt, /Use OOC only for an out-of-character answer/);
    assert.doesNotMatch(prompt, /If no NORMAL semantic change is known, use mode OOC or FLASH/);
});

