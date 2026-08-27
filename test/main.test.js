import test from 'node:test';
import assert from 'node:assert/strict';
import { HostAdapter } from '../src/adapter.js';
import { ChatStore } from '../src/store.js';
import { previewLocalPhoneGfx, runtimeState, setGfxRuntimeSettings, setGlobalRuntimeMode, setRuntimeMode } from '../src/main.js';

function resetRuntime() {
    runtimeState.adapter = null;
    runtimeState.store = null;
    runtimeState.engine = null;
    runtimeState.settings = null;
    runtimeState.ui = null;
    runtimeState.gfxOverlay = null;
    runtimeState.bound = false;
    runtimeState.active = true;
    runtimeState.chatTopology = [];
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

test('local GFX settings persist, roll back on failure, and both phone previews are available', async () => {
    const settings = { stState: { gfxEnabled: true, gfxDurationMs: 7000 } };
    const previews = [];
    let saves = 0;
    runtimeState.adapter = {
        getSettings: () => settings,
        saveSettingsDebounced: async () => { saves += 1; },
    };
    runtimeState.gfxOverlay = {
        configure: () => {},
        replaceBranch: (_branch, events) => previews.push(events[0]),
    };
    try {
        assert.deepEqual(await setGfxRuntimeSettings({ enabled: false, durationMs: 10000 }), { enabled: false, durationMs: 10000 });
        assert.equal(saves, 1);
        assert.equal(settings.stState.gfxEnabled, false);
        settings.stState.gfxEnabled = true;
        assert.equal(previewLocalPhoneGfx('ios').platform, 'ios');
        assert.equal(previewLocalPhoneGfx('android').platform, 'android');
        assert.deepEqual(previews.map((event) => event.platform), ['ios', 'android']);

        runtimeState.adapter.saveSettingsDebounced = async () => { throw new Error('gfx settings offline'); };
        await assert.rejects(setGfxRuntimeSettings({ enabled: false, durationMs: 5000 }), /gfx settings offline/);
        assert.equal(settings.stState.gfxEnabled, true);
        assert.equal(settings.stState.gfxDurationMs, 10000);
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

test('successful mode changes clear any Shadow overlay', async () => {
    const metadata = { stStateConfig: { mode: 'SHADOW' } };
    let clears = 0;
    runtimeState.adapter = {
        getMetadata: () => metadata,
        getChat: () => [],
        getChatId: () => 'chat',
        saveMetadata: async () => {},
    };
    runtimeState.gfxOverlay = { clear: () => { clears += 1; } };
    try {
        assert.equal(await setRuntimeMode('LEGACY'), 'LEGACY');
        assert.equal(clears, 1);
    } finally { resetRuntime(); }
});

test('HostAdapter guarded chat save detects a chat switch during persistence', async () => {
    const context = {
        chatId: 'old-chat',
        saveChat: async () => { context.chatId = 'new-chat'; },
    };
    const adapter = new HostAdapter(() => context);
    await assert.rejects(adapter.saveChat({ expectedChatId: 'old-chat' }), /active chat changed/i);
});
