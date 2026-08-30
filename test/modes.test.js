import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CHAT_CONFIG_KEY,
    DEFAULT_ENGINE_MODE,
    ENGINE_MODES,
    NATIVE_MODE_LOCKED,
    SELECTABLE_MODES,
    SETTINGS_KEY,
    ensureGlobalSettings,
    getChatMode,
    modeCapabilities,
    setChatMode,
    setGlobalDefaultMode,
} from '../src/modes.js';

test('global default and per-chat mode support opt-in Hybrid Native', () => {
    const settings = {};
    const global = ensureGlobalSettings(settings);
    assert.equal(global.defaultMode, DEFAULT_ENGINE_MODE);
    assert.equal(settings[SETTINGS_KEY].nativeLocked, false);
    assert.equal(NATIVE_MODE_LOCKED, false);
    assert.ok(SELECTABLE_MODES.includes('NATIVE'));
    setGlobalDefaultMode(settings, 'SHADOW');
    const metadata = {};
    assert.equal(getChatMode(metadata, settings), 'SHADOW');
    assert.equal(setChatMode(metadata, 'RECOVERY'), 'RECOVERY');
    assert.equal(metadata[CHAT_CONFIG_KEY].mode, 'RECOVERY');
    assert.equal(getChatMode(metadata, settings), 'RECOVERY');
    assert.equal(setChatMode(metadata, 'NATIVE'), 'NATIVE');
    assert.equal(getChatMode(metadata, settings), 'NATIVE');
    assert.deepEqual(modeCapabilities('NATIVE'), {
        mode: 'NATIVE', inject: true, process: true, canonicalWrites: true,
        candidateWrites: false, nativeLocked: false, recoveryWrites: false,
    });
    assert.deepEqual(ENGINE_MODES, ['LEGACY', 'SHADOW', 'NATIVE', 'RECOVERY']);
});

