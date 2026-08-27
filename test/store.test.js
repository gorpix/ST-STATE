import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatStore } from '../src/store.js';
import { checkpointAssistantSlot, createBranchLedger } from '../src/branch.js';
import { createEmptyState } from '../src/schema.js';

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
    assert.equal(host.contexts.one.chatMetadata.stState.scene.openBeat, 'one');
    assert.equal(host.contexts.two.chatMetadata.stState.scene.openBeat, 'two');
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

test('shadow sidecar keeps bounded report history and seen identities', async () => {
    const host = makeHost();
    const store = new ChatStore(host, { now: () => 1 });
    const state = store.load();
    await store.saveShadowCommit(state, { version: 1, status: 'match', messageId: 'm1', transactionId: 't1' }, { expectedChatId: 'one' });
    await store.saveShadowReport({ version: 1, status: 'diverged', messageId: 'm2', transactionId: 't2' }, { expectedChatId: 'one' });
    const sidecar = store.getShadowReport();
    assert.equal(sidecar.status, 'diverged');
    assert.equal(sidecar.reports.length, 2);
    assert.deepEqual(sidecar.seen, ['message:m1', 'tx:t1', 'message:m2', 'tx:t2']);
});

test('branch state, ledger, and report persist atomically and roll back together', async () => {
    const host = makeHost();
    const store = new ChatStore(host, { now: () => 1 });
    const before = createEmptyState({ now: 1 });
    await store.save(before, { expectedChatId: 'one' });
    const checkpoint = checkpointAssistantSlot(createBranchLedger(), { slotId: 'slot:one:1', messageId: 'slot:one:1', index: 1, swipeIndex: 0, state: before });
    const after = structuredClone(before); after.ct = 1; after.meta.ct = 1; after.scene.openBeat = 'branch';
    await store.saveBranchCommit(after, checkpoint.ledger, { version: 1, status: 'branch_selected', messageId: 'swipe:0' }, { expectedChatId: 'one' });
    assert.equal(store.load().ct, 1);
    assert.equal(store.loadBranchLedger().slots['slot:one:1'].checkpointCt, 0);
    assert.equal(store.getShadowReport().status, 'branch_selected');

    const metadataBeforeFailure = structuredClone(host.contexts.one.chatMetadata);
    host.saveMetadata = async () => { throw new Error('offline'); };
    after.ct = 2; after.meta.ct = 2;
    await assert.rejects(store.saveBranchCommit(after, createBranchLedger(), { version: 1, status: 'bad' }, { expectedChatId: 'one' }), /offline/);
    assert.deepEqual(host.contexts.one.chatMetadata, metadataBeforeFailure);
});

test('oversized full-state branch checkpoints are rejected before metadata persistence', async () => {
    const host = makeHost();
    const store = new ChatStore(host, { now: () => 1 });
    const state = createEmptyState({ now: 1 });
    state.opaque.unknownRoot.large = 'x'.repeat(1_600_000);
    const checkpoint = checkpointAssistantSlot(createBranchLedger(), { slotId: 'slot:large', messageId: 'large', index: 1, state });
    await assert.rejects(store.saveBranchLedger(checkpoint.ledger, { expectedChatId: 'one' }), /too large/);
    assert.equal(host.contexts.one.chatMetadata.stStateBranches, undefined);
});


