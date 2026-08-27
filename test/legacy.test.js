import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importLegacyState, exportLegacyState } from '../src/legacy.js';
import { createEmptyState } from '../src/schema.js';
import { deepEqual } from '../src/util.js';

const fixture = fs.readFileSync(new URL('./fixtures/legacy.html', import.meta.url), 'utf8');

test('imports every current legacy section and preserves unknown/World Sim data', () => {
    const result = importLegacyState(fixture, { now: 99 });
    assert.equal(result.ok, true);
    const state = result.state;
    assert.equal(state.ct, 12);
    assert.equal(state.actors.AL.name, 'Alice');
    assert.equal(state.actors.BO.name, 'Bob');
    assert.equal(state.factions['Lantern Guild'].goal, 'Keep the light');
    assert.equal(state.relations.pairs['AL|BO'].bond, 8);
    assert.equal(state.relations.profiles['AL->BO'].trust, 'Reliable');
    assert.equal(state.residue[0].event, 'rescued at the bridge');
    assert.equal(state.quests[0].objective, 'Find the key');
    assert.equal(state.inventory.items[0], 'brass key, rope');
    assert.equal(state.chekhov.active[0], 'a loose tile');
    assert.equal(state.thoughts[0].thoughts, 'Do not drop the key');
    assert.equal(state.notebook[0], '[T] The bell thread continues');
    assert.equal(state.lastDnd.Outcome, 'Success');
    assert.match(state.worldSim.raw, /WORLD SIM/);
    assert.ok(state.opaque.legacy.sections['🧪 FUTURE SECTION']);
});

test('legacy relationship row shape and semantic round trip are stable', () => {
    const imported = importLegacyState(fixture).state;
    const exported = exportLegacyState(imported);
    assert.match(exported, /- <b>Alice<\/b> ↔ <b>Bob<\/b> \| BOND: 8 \| Sparks: 2 \| Grudge: 1/);
    const roundTrip = importLegacyState(exported).state;
    assert.equal(roundTrip.ct, imported.ct);
    assert.deepEqual(roundTrip.relations.pairs['AL|BO'].bond, imported.relations.pairs['AL|BO'].bond);
    assert.equal(roundTrip.relations.profiles['AL->BO'].boundary, imported.relations.profiles['AL->BO'].boundary);
    assert.ok(roundTrip.opaque.legacy.sections['🧪 FUTURE SECTION']);
    assert.match(exported, /distant bells/);
});

test('explicit legacy actor IDs survive import/export without renaming', () => {
    const source = `<!-- GFX_START -->\n<internal_states>\n<details><summary>🎬 INTERNAL STATES (Turn: 3)</summary>\n<details><summary>👥 NPC STATE</summary>\n- [QZ] Quill | At: desk | Doing: writing | Agenda: None | VAD: 0/0/0 | Focus: ink | Aware: room | Fibs: None | Circle: None | Body: well\n</details>\n<details><summary>💚 BONDS</summary>\n- Quill ↔ User | BOND: 2 | Sparks: 0 | Grudge: 0\n</details>\n</details>\n</internal_states>\n<!-- GFX_END -->`;
    const imported = importLegacyState(source).state;
    assert.equal(imported.actors.QZ.name, 'Quill');
    assert.equal(imported.relations.pairs['QZ|US'].a, 'QZ');
    const exported = exportLegacyState(imported);
    const roundTrip = importLegacyState(exported).state;
    assert.equal(roundTrip.actors.QZ.name, 'Quill');
    assert.equal(roundTrip.relations.pairs['QZ|US'].b, 'US');
});

test('strict import accepts an omitted optional World Sim and preserves prior opaque data', () => {
    const base = createEmptyState({ now: 1 });
    base.worldSim = { raw: '<details><summary>🌎 WORLD SIM</summary>prior simulation</details>', data: null };
    base.opaque.legacy.worldSimRaw = base.worldSim.raw;
    const complete = exportLegacyState(base);
    const withoutWorldSim = complete.replace(/<details><summary>🌎 WORLD SIM<\/summary>[\s\S]*?<\/details>\s*/i, '');
    const imported = importLegacyState(withoutWorldSim, { now: 2, baseState: base, requireComplete: true });
    assert.equal(imported.ok, true);
    assert.equal(imported.state.worldSim.raw, base.worldSim.raw);
    assert.equal(imported.state.opaque.legacy.worldSimRaw, base.opaque.legacy.worldSimRaw);
});

