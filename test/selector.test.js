import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from '../src/schema.js';
import { selectHotState, buildHotStatePack, buildProtocolPrompt, formatDicePool } from '../src/selector.js';

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
    assert.match(prompt, /Ordinary RP always uses NORMAL, even with no data lines/);
    assert.match(prompt, /Use OOC only for an out-of-character answer/);
    assert.match(prompt, /valence, arousal, and dominance must each be finite numbers clamped to -2\.\.2/);
    assert.match(prompt, /Copy actor IDs exactly from ST_LOCAL_FRAME/);
    assert.match(prompt, /Patch transport is line-based, never JSON/);
    assert.match(prompt, /actor\.set\|ID\|field\|value/);
    assert.match(prompt, /copy the value character-for-character/);
    assert.match(prompt, /Omitted sections and omitted cold actor\/relation\/position rows are carried forward unchanged/);
    assert.match(prompt, /Include NPC STATE, BONDS, and SCENE & WORLD on every NORMAL turn/);
    assert.doesNotMatch(prompt, /If no NORMAL semantic change is known, use mode OOC or FLASH/);
});

test('Hybrid Native injects local frame, authoritative patch rules, compatibility boundary, and present-NPC pre-rolls', () => {
    const state = createEmptyState({ now: 1 });
    state.actors = {
        US: { id: 'US', name: 'User', at: 'room' },
        AL: { id: 'AL', name: 'Alice', at: 'room' },
        BO: { id: 'BO', name: 'Bob', at: 'elsewhere' },
    };
    state.scene.positions = { AL: 'room' };
    const prompt = buildProtocolPrompt(state, { mode: 'NATIVE', rollProvider: () => 14 });
    assert.match(prompt.text, /mode=NATIVE/);
    assert.match(prompt.text, /ST-STATE HYBRID NATIVE TRANSACTION PROTOCOL v1/);
    assert.match(prompt.text, /ST_LOCAL_FRAME v1/);
    assert.match(prompt.text, /ST_DICE_POOL v1\nAL\|d20\|14\nEND_ST_DICE_POOL/);
    assert.match(prompt.text, /Never output the full legacy state/);
    assert.match(prompt.text, /only those changed sections/);
    assert.match(prompt.text, /exactly one hidden ST_PATCH/);
    assert.doesNotMatch(formatDicePool(prompt.selection, { rollProvider: () => 9 }), /US\|d20/);
    assert.doesNotMatch(formatDicePool(prompt.selection, { rollProvider: () => 9 }), /BO\|d20/);
});

