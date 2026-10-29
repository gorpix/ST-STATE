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
        EF: { id: 'EF', name: 'Eve', at: 'couch behind Alice' },
    };
    state.scene.spotlight = ['AL'];
    state.scene.positions = { AL: 'room', BO: 'room' };
    state.relations.pairs = {
        'AL|BO': { a: 'AL', b: 'BO', bond: 4, sparks: 0, grudge: 0 },
        'BO|CA': { a: 'BO', b: 'CA', bond: 2, sparks: 0, grudge: 0 },
        'CA|DE': { a: 'CA', b: 'DE', bond: 2, sparks: 0, grudge: 0 },
    };
    const selected = selectHotState(state, { userText: 'Alice asks about the lantern.' });
    assert.deepEqual(selected.selectedActorIds.sort(), ['AL', 'BO', 'EF', 'US'].sort());
    assert.deepEqual(selected.selectedRelationKeys.sort(), ['AL|BO', 'BO|CA'].sort());
    assert.ok(selected.coldActorIds.includes('CA'));
    assert.ok(!selected.coldActorIds.includes('EF'));
    const pack = buildHotStatePack(state, { userText: 'Alice asks about the lantern.' });
    assert.match(pack, /ST_STATE_PACK v2/);
    assert.match(pack, /ACTOR/);
    assert.doesNotMatch(pack, /Carol/);
    assert.match(pack, /Eve/);
});

test('protocol keeps an ordinary zero-delta RP turn NORMAL', () => {
    const prompt = buildProtocolPrompt(createEmptyState({ now: 1 })).text;
    assert.match(prompt, /ST-STATE SHADOW PROTOCOL v2/);
    assert.match(prompt, /ST_DICE_POOL v1\nBOOTSTRAP:ACTIVE_CARD_NPC\|d20\|\d+\nEND_ST_DICE_POOL/);
    assert.match(prompt, /NORMAL reply order: the preset's header, prose, the <internal_states> block, one ST_PATCH/);
    assert.match(prompt, /Nothing comes before the header/);
    assert.match(prompt, /A turn with no changes still sends the headers; ct advances on its own/);
    assert.match(prompt, /valence, arousal, and dominance -2\.\.2/);
    assert.match(prompt, /Use actor IDs exactly as ST_LOCAL_FRAME lists them/);
    assert.match(prompt, /never JSON/);
    assert.match(prompt, /actor\.set\|ID\|field\|value/);
    assert.match(prompt, /copy each changed value character-for-character/i);
    assert.match(prompt, /it never changes the state/);
    assert.match(prompt, /Include NPC STATE, BONDS, and SCENE & WORLD every NORMAL turn/);
    assert.match(prompt, /base=GENESIS\nmode=NORMAL\ntx=turn-1\n-->/);
    assert.doesNotMatch(prompt, /actor\.hold/);
    assert.doesNotMatch(prompt, /If no NORMAL semantic change is known, use mode OOC or FLASH/);
});

test('both modes route OOC and FLASH the same way and avoid scripted audits', () => {
    for (const mode of ['SHADOW', 'NATIVE']) {
        const prompt = buildProtocolPrompt(createEmptyState({ now: 1 }), { mode }).text;
        assert.match(prompt, /OOC and FLASH replies change no state/);
        assert.match(prompt, /An OOC reply ends with the same envelope using mode=OOC; a FLASH reply ends with its <flash_handoff\/>/);
        assert.doesNotMatch(prompt, /no ST_PATCH/);
        assert.doesNotMatch(prompt, /AUDIT|audit carried|Briefly shape the patch/);
        assert.doesNotMatch(prompt, /exact header required by the active preset/);
    }
});

test('GFX rules follow the local renderer setting in both modes', () => {
    for (const mode of ['SHADOW', 'NATIVE']) {
        const on = buildProtocolPrompt(createEmptyState({ now: 1 }), { mode }).text;
        assert.match(on, /Pop-in graphic \(optional, NORMAL only\)/);
        assert.match(on, /<!--ST_GFX\nV1\nkind=terminal\|phone/);
        assert.match(on, /never use GFX_START\/GFX_END for it/);
        const off = buildProtocolPrompt(createEmptyState({ now: 1 }), { mode, gfx: false }).text;
        assert.doesNotMatch(off, /ST_GFX\nV1|Pop-in graphic/);
    }
    assert.doesNotMatch(buildProtocolPrompt(createEmptyState({ now: 1 }), { mode: 'LEGACY' }).text, /ST_GFX/);
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
    assert.match(prompt.text, /ST-STATE HYBRID NATIVE PROTOCOL v2/);
    assert.match(prompt.text, /ST_LOCAL_FRAME v1/);
    assert.match(prompt.text, /ST_DICE_POOL v1\nAL\|d20\|14\nEND_ST_DICE_POOL/);
    assert.match(prompt.text, /never output the full legacy state/);
    assert.match(prompt.text, /Write the patch once, in the reply, not in reasoning/);
    assert.match(prompt.text, /only those changed sections/);
    assert.match(prompt.text, /The patch replaces the NPC STATE, SCENE & WORLD, numeric BONDS, and EMOTIONAL RESIDUE sections/);
    assert.match(prompt.text, /residue\.set\|RID\|field\|value/);
    assert.match(prompt.text, /actor\.hold\|ID\|field\|value/);
    assert.match(prompt.text, /actor\.set\|ID\|thoughts\|text/);
    assert.match(prompt.text, /ST_OUTPUT_TAIL_LATCH v1/);
    assert.match(prompt.text, /If space runs short, shorten prose, never the patch/);
    assert.match(prompt.text, /actor\.clear\|ID\|field/);
    assert.match(prompt.text, /scene\.position\.remove\|ID/);
    assert.match(prompt.text, /base=GENESIS\nmode=NORMAL\ntx=turn-1\n-->\nEND_ST_OUTPUT_TAIL_LATCH$/);
    assert.doesNotMatch(formatDicePool(prompt.selection, { rollProvider: () => 9 }), /US\|d20/);
    assert.doesNotMatch(formatDicePool(prompt.selection, { rollProvider: () => 9 }), /BO\|d20/);
});

test('dice pool bootstraps from the card name before canonical actors exist', () => {
    const prompt = buildProtocolPrompt(createEmptyState({ now: 1 }), {
        mode: 'NATIVE',
        bootstrapNpcNames: ['Alice'],
        rollProvider: () => 11,
    });
    assert.match(prompt.dicePool, /BOOTSTRAP:Alice\|d20\|11/);
    assert.match(prompt.text, /BOOTSTRAP: labels are dice only, never actors/);
});

