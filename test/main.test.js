import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatStore } from '../src/store.js';
import { runtimeState, setGlobalRuntimeMode, setRuntimeMode } from '../src/main.js';

function resetRuntime() {
    runtimeState.adapter = null;
    runtimeState.store = null;
    runtimeState.engine = null;
    runtimeState.settings = null;
    runtimeState.ui = null;
}

test('chat mode persistence failure restores the previous metadata configuration', async () => {
    const metadata = { stStateConfig: { mode: 'LEGACY', updatedAt: 1 } };
    const adapter = {
        getMetadata: () => metadata,
        getChat: () => [],
        getChatId: () => 'chat',
        saveMetadata: async () => { throw new Error('offline'); },
    };
    runtimeState.adapter = adapter;
    runtimeState.store = new ChatStore(adapter, { now: () => 1 });
    try {
        await assert.rejects(setRuntimeMode('SHADOW'), /offline/);
        assert.deepEqual(metadata.stStateConfig, { mode: 'LEGACY', updatedAt: 1 });
    } finally { resetRuntime(); }
});

test('global default mode uses settings persistence and rolls back on failure', async () => {
    const settings = { stState: { enabled: true, diagnostics: true, defaultMode: 'LEGACY', nativeLocked: true } };
    let saves = 0;
    runtimeState.adapter = {
        getSettings: () => settings,
        saveSettingsDebounced: async () => { saves += 1; },
    };
    try {
        assert.equal(await setGlobalRuntimeMode('RECOVERY'), 'RECOVERY');
        assert.equal(settings.stState.defaultMode, 'RECOVERY');
        assert.equal(saves, 1);
        runtimeState.adapter.saveSettingsDebounced = async () => { throw new Error('settings offline'); };
        await assert.rejects(setGlobalRuntimeMode('SHADOW'), /settings offline/);
        assert.equal(settings.stState.defaultMode, 'RECOVERY');
    } finally { resetRuntime(); }
});

test('shadow mode selection is rejected until an existing legacy chat has a baseline', async () => {
    const metadata = {};
    let saves = 0;
    const adapter = {
        getMetadata: () => metadata,
        getChat: () => [{ mes: '<internal_states>old ledger</internal_states>' }],
        getChatId: () => 'chat',
        saveMetadata: async () => { saves += 1; },
    };
    runtimeState.adapter = adapter;
    runtimeState.store = new ChatStore(adapter, { now: () => 1 });
    try {
        await assert.rejects(setRuntimeMode('SHADOW'), /Import the latest chat/);
        assert.equal(saves, 0);
        assert.equal(metadata.stStateConfig, undefined);
        assert.equal(metadata.stState, undefined);
    } finally { resetRuntime(); }
});
