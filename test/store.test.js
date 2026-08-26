import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatStore } from '../src/store.js';

function makeHost() {
    const contexts = {
        one: { chatId: 'one', chatMetadata: {}, extensionSettings: {}, saveMetadata: async function () { this.saved = (this.saved || 0) + 1; } },
        two: { chatId: 'two', chatMetadata: {}, extensionSettings: {}, saveMetadata: async function () { this.saved = (this.saved || 0) + 1; } },
    };
    let active = 'one';
    const host = {
        getMetadata: () => contexts[active].chatMetadata,
        getChatId: () => contexts[active].chatId,
        saveMetadata: () => contexts[active].saveMetadata(),
        switch: (id) => { active = id; },
        context: () => contexts[active],
        contexts,
    };
    return host;
}

test('store reads fresh chat metadata reference after chat switch', async () => {
    const host = makeHost();
    const store = new ChatStore(host, { now: () => 1 });
    const first = store.load(); first.scene.openBeat = 'one'; await store.save(first, { expectedChatId: 'one' });
    host.switch('two');
    const second = store.load();
    assert.equal(second.scene.openBeat, 'None');
    second.scene.openBeat = 'two'; await store.save(second, { expectedChatId: 'two' });
    assert.equal(host.contexts.one.chatMetadata.ff5Engine.scene.openBeat, 'one');
    assert.equal(host.contexts.two.chatMetadata.ff5Engine.scene.openBeat, 'two');
});

test('backup/restore previews diff before writing and migrates old version', async () => {
    const host = makeHost();
    const store = new ChatStore(host, { now: () => 1 });
    const state = store.load(); state.scene.openBeat = 'new'; await store.save(state, { expectedChatId: 'one' });
    const backup = store.backup();
    state.scene.openBeat = 'changed'; await store.save(state, { expectedChatId: 'one' });
    const preview = store.previewRestore(backup);
    assert.equal(preview.changed, true);
    assert.ok(preview.diff.forward.some((change) => change.path === 'scene.openBeat'));
    await store.restore(backup, { expectedChatId: 'one' });
    assert.equal(store.load().scene.openBeat, 'new');
    const migrated = store.parseBackup(JSON.stringify({ version: 1, ct: 2, head: 'old', scene: {} }));
    assert.equal(migrated.state.schemaVersion, 2);
    assert.equal(migrated.state.ct, 2);
});


