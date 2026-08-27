import test from 'node:test';
import assert from 'node:assert/strict';
import { HostAdapter } from '../src/adapter.js';
import { STStateEngine } from '../src/engine.js';
import { exportLegacyState } from '../src/legacy.js';
import {
    clearCurrentChatState,
    handleMessageDeleted,
    handleMessageEdited,
    handleMessageReceived,
    handleMessageSwiped,
    handleMessageSwipeDeleted,
    rebaselineSelectedBranch,
    restorePreviousState,
    runtimeState,
} from '../src/main.js';
import { getChatMode, setChatMode } from '../src/modes.js';
import { createEmptyState } from '../src/schema.js';
import { ChatStore } from '../src/store.js';

function stateAt(ct, openBeat) {
    const state = createEmptyState({ now: 1 });
    state.actors = { US: { id: 'US', name: 'User' }, AL: { id: 'AL', name: 'Alice' } };
    state.ct = ct;
    state.meta.ct = ct;
    state.scene.openBeat = openBeat;
    state.meta.createdAt = 123;
    state.history = [{ transactionId: 'prior' }];
    state.dedupe = ['prior'];
    return state;
}

function reply(state, base, tx) {
    return `Reply ${state.scene.openBeat} ${exportLegacyState(state)} <!--ST_PATCH\nV2\nbase=${base}\nmode=NORMAL\ntx=${tx}\nscene.set|openBeat|${state.scene.openBeat}\n-->`;
}

function setup() {
    const initial = stateAt(0, 'before');
    const context = {
        chatId: 'chat',
        chatMetadata: { stState: initial },
        chat: [{ is_user: true, mes: 'Continue.' }],
        extensionSettings: { stState: { defaultMode: 'SHADOW', enabled: true, diagnostics: true } },
        setExtensionPrompt: () => {},
        saveMetadata: async () => { context.metadataSaves = (context.metadataSaves ?? 0) + 1; },
        saveChat: async () => { context.chatSaves = (context.chatSaves ?? 0) + 1; },
    };
    setChatMode(context.chatMetadata, 'SHADOW', { now: 1 });
    const adapter = new HostAdapter(() => context);
    const store = new ChatStore(adapter, { now: () => 5 });
    const engine = new STStateEngine({ adapter, store, now: () => 5 });
    runtimeState.adapter = adapter;
    runtimeState.store = store;
    runtimeState.engine = engine;
    runtimeState.settings = context.extensionSettings.stState;
    runtimeState.active = true;
    runtimeState.ui = null;
    runtimeState.gfxOverlay = null;
    return { context, adapter, store, engine, initial };
}

function resetRuntime() {
    runtimeState.adapter = null;
    runtimeState.store = null;
    runtimeState.engine = null;
    runtimeState.settings = null;
    runtimeState.ui = null;
    runtimeState.gfxOverlay = null;
    runtimeState.bound = false;
}

test('new and existing swipes restore one pre-response checkpoint without ct drift', async () => {
    const { context, store, initial } = setup();
    try {
        const firstState = stateAt(1, 'first branch');
        const firstRaw = reply(firstState, initial.head, 'turn-1-a');
        const message = {
            is_user: false,
            mes: firstRaw,
            extra: {},
            swipe_id: 0,
            swipes: [firstRaw],
            swipe_info: [{ extra: {} }],
        };
        context.chat.push(message);
        const first = await handleMessageReceived({ messageId: 1 });
        assert.equal(first.status, 'shadow_match');
        assert.equal(store.load().ct, 1);
        assert.equal(store.load().scene.openBeat, 'first branch');
        assert.equal(store.loadBranchLedger().slots['slot:chat:1'].checkpointCt, 0);

        message.swipe_id = 1;
        message.extra = {};
        const pending = await handleMessageSwiped(1);
        assert.equal(pending.status, 'branch_checkpoint');
        assert.equal(store.load().ct, 0);

        const secondState = stateAt(1, 'second branch');
        const secondRaw = reply(secondState, initial.head, 'turn-1-b');
        message.mes = secondRaw;
        message.swipes.push(secondRaw);
        message.swipe_info.push({ send_date: 'swipe-b', extra: {} });
        const second = await handleMessageReceived({ messageId: 1 });
        assert.equal(second.status, 'shadow_match');
        assert.equal(store.load().ct, 1);
        assert.equal(store.load().scene.openBeat, 'second branch');

        message.swipe_id = 0;
        message.mes = message.swipes[0];
        message.extra = {};
        const selected = await handleMessageSwiped(1);
        assert.equal(selected.status, 'branch_selected');
        assert.equal(store.load().ct, 1);
        assert.equal(store.load().scene.openBeat, 'first branch');
        assert.deepEqual(store.load().history, initial.history);
        assert.deepEqual(store.load().dedupe, initial.dedupe);
        assert.equal(store.load().meta.createdAt, 123);
    } finally { resetRuntime(); }
});

test('edit and delete events rebaseline or roll back from the retained checkpoint', async () => {
    const { context, store, initial } = setup();
    try {
        const firstState = stateAt(1, 'first branch');
        const raw = reply(firstState, initial.head, 'turn-1');
        const message = { is_user: false, mes: raw, extra: {}, swipe_id: 0, swipes: [raw], swipe_info: [{ extra: {} }] };
        context.chat.push(message);
        await handleMessageReceived({ messageId: 1 });

        const editedState = stateAt(1, 'edited branch');
        message.mes = reply(editedState, initial.head, 'edited');
        message.swipes[0] = message.mes;
        const edited = await handleMessageEdited(1);
        assert.equal(edited.status, 'edit_rebaseline');
        assert.equal(store.load().scene.openBeat, 'edited branch');
        assert.doesNotMatch(message.mes, /ST_PATCH/);

        context.chat.splice(1, 1);
        const deleted = await handleMessageDeleted(1);
        assert.equal(deleted.status, 'delete_rollback');
        assert.equal(store.load().ct, 0);
        assert.equal(store.load().scene.openBeat, 'before');
    } finally { resetRuntime(); }
});

test('manual recovery actions rebaseline, restore, and clear only current-chat state', async () => {
    const { context, store, initial } = setup();
    try {
        const firstState = stateAt(1, 'first branch');
        const raw = reply(firstState, initial.head, 'turn-1');
        const message = { is_user: false, mes: raw, extra: {}, swipe_id: 0, swipes: [raw], swipe_info: [{ extra: {} }] };
        context.chat.push(message);
        await handleMessageReceived({ messageId: 1 });

        await restorePreviousState({ expectedChatId: 'chat' });
        assert.equal(store.load().ct, 0);
        const rebaseline = await rebaselineSelectedBranch({ expectedChatId: 'chat' });
        assert.match(rebaseline.message, /ct 1/);
        assert.equal(store.load().scene.openBeat, 'first branch');
        assert.deepEqual(store.loadBranchLedger().slots, {});

        const cleared = await clearCurrentChatState({ expectedChatId: 'chat' });
        assert.match(cleared.message, /LEGACY/);
        assert.equal(context.chatMetadata.stState, undefined);
        assert.equal(context.chatMetadata.stStateShadow, undefined);
        assert.equal(context.chatMetadata.stStateBranches, undefined);
        assert.equal(context.chatMetadata.stStateConfig.mode, 'LEGACY');
        assert.equal(context.chat.length, 2);
    } finally { resetRuntime(); }
});

test('LEGACY mode remains inert for message and swipe-delete branch bookkeeping', async () => {
    const { context, store, initial } = setup();
    try {
        setChatMode(context.chatMetadata, 'LEGACY', { now: 1 });
        const state = stateAt(1, 'legacy');
        const raw = reply(state, initial.head, 'legacy');
        context.chat.push({ is_user: false, mes: raw, extra: {}, swipe_id: 0, swipes: [raw], swipe_info: [{ extra: {} }] });
        const result = await handleMessageReceived({ messageId: 1 });
        assert.equal(result.status, 'legacy');
        assert.equal((await handleMessageSwipeDeleted({ messageId: 1, swipeId: 0 })).status, 'ignored');
        assert.equal(context.chatMetadata.stStateBranches, undefined);
        assert.equal(store.load().ct, 0);
        assert.equal(getChatMode(context.chatMetadata, context.extensionSettings), 'LEGACY');
    } finally { resetRuntime(); }
});

test('post-splice delete payload detects the removed middle message and rolls back later state', async () => {
    const { context, store, initial } = setup();
    try {
        const first = stateAt(1, 'first');
        const firstRaw = reply(first, initial.head, 'first');
        context.chat.push({ is_user: false, mes: firstRaw, extra: {}, swipe_id: 0, swipes: [firstRaw], swipe_info: [{ send_date: 'a', extra: {} }] });
        await handleMessageReceived({ messageId: 1 });
        context.chat.push({ is_user: true, mes: 'Second user turn.' });
        const second = stateAt(2, 'second');
        const secondRaw = reply(second, store.load().head, 'second');
        context.chat.push({ is_user: false, mes: secondRaw, extra: {}, swipe_id: 0, swipes: [secondRaw], swipe_info: [{ send_date: 'b', extra: {} }] });
        await handleMessageReceived({ messageId: 3 });
        assert.equal(store.load().ct, 2);

        context.chat.splice(2, 1);
        const deleted = await handleMessageDeleted(context.chat.length);
        assert.equal(deleted.status, 'delete_rollback');
        assert.equal(store.load().ct, 1);
        assert.equal(store.load().scene.openBeat, 'first');
        assert.equal(store.loadBranchLedger().slots['slot:chat:3'].status, 'deleted');
    } finally { resetRuntime(); }
});

test('editing a user message rolls back every later assistant checkpoint', async () => {
    const { context, store, initial } = setup();
    try {
        const first = stateAt(1, 'first');
        const firstRaw = reply(first, initial.head, 'first');
        context.chat.push({ is_user: false, mes: firstRaw, extra: {}, swipe_id: 0, swipes: [firstRaw], swipe_info: [{ extra: {} }] });
        await handleMessageReceived({ messageId: 1 });
        context.chat.push({ is_user: true, mes: 'Second user turn.' });
        const second = stateAt(2, 'second');
        const secondRaw = reply(second, store.load().head, 'second');
        context.chat.push({ is_user: false, mes: secondRaw, extra: {}, swipe_id: 0, swipes: [secondRaw], swipe_info: [{ extra: {} }] });
        await handleMessageReceived({ messageId: 3 });

        context.chat[2].mes = 'Edited second user turn.';
        const edited = await handleMessageEdited(2);
        assert.equal(edited.status, 'user_edit_rollback');
        assert.equal(store.load().ct, 1);
        assert.equal(store.load().scene.openBeat, 'first');
    } finally { resetRuntime(); }
});

test('deleting a swipe rebuilds stable identities for shifted remaining ordinals', async () => {
    const { context, store, initial } = setup();
    try {
        const first = stateAt(1, 'first');
        const firstRaw = reply(first, initial.head, 'first');
        const message = { is_user: false, mes: firstRaw, extra: {}, swipe_id: 0, swipes: [firstRaw], swipe_info: [{ send_date: 'swipe-a', extra: {} }] };
        context.chat.push(message);
        await handleMessageReceived({ messageId: 1 });

        message.swipe_id = 1;
        await handleMessageSwiped(1);
        const second = stateAt(1, 'second');
        const secondRaw = reply(second, initial.head, 'second');
        message.mes = secondRaw;
        message.swipes.push(secondRaw);
        message.swipe_info.push({ send_date: 'swipe-b', extra: {} });
        await handleMessageReceived({ messageId: 1 });

        message.swipes.splice(0, 1);
        message.swipe_info.splice(0, 1);
        message.swipe_id = 0;
        message.mes = message.swipes[0];
        const rebuilt = await handleMessageSwipeDeleted({ messageId: 1, swipeId: 0, newSwipeId: 0 });
        assert.equal(rebuilt.status, 'swipe_reindexed');
        const keys = Object.keys(store.loadBranchLedger().slots['slot:chat:1'].swipes);
        assert.equal(keys.length, 1);
        assert.match(keys[0], /id:swipe-b$/);
        const selected = await handleMessageSwiped(1);
        assert.equal(selected.status, 'branch_selected');
        assert.equal(store.load().scene.openBeat, 'second');
    } finally { resetRuntime(); }
});

test('branch persistence failure stores a RECOVERY safety latch', async () => {
    const { context, store, initial } = setup();
    try {
        const first = stateAt(1, 'first');
        const raw = reply(first, initial.head, 'first');
        const message = { is_user: false, mes: raw, extra: {}, swipe_id: 0, swipes: [raw], swipe_info: [{ extra: {} }] };
        context.chat.push(message);
        await handleMessageReceived({ messageId: 1 });
        message.swipe_id = 1;
        store.saveBranchCommit = async () => { throw new Error('branch storage offline'); };
        const failed = await handleMessageSwiped(1);
        assert.equal(failed.status, 'persistence_error');
        assert.equal(context.chatMetadata.stStateConfig.mode, 'RECOVERY');
        assert.ok((context.metadataSaves ?? 0) > 0);
    } finally { resetRuntime(); }
});

test('missing branch checkpoints clear stale local graphics on every branch event', async () => {
    const { context } = setup();
    let clears = 0;
    runtimeState.gfxOverlay = { clear: () => { clears += 1; } };
    const message = { is_user: false, mes: 'Old untracked reply', swipe_id: 0, swipes: ['Old untracked reply'], swipe_info: [{}] };
    context.chat.push(message);
    try {
        assert.equal((await handleMessageSwiped(1)).status, 'missing_checkpoint');
        assert.equal((await handleMessageEdited(1)).status, 'missing_checkpoint');
        assert.equal((await handleMessageSwipeDeleted({ messageId: 1, swipeId: 0 })).status, 'missing_checkpoint');
        assert.equal(clears, 3);
    } finally { resetRuntime(); }
});
