import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CHAT_CONFIG_KEY,
    DEFAULT_ENGINE_MODE,
    ENGINE_MODES,
    SETTINGS_KEY,
    ensureGlobalSettings,
    getChatMode,
    setChatMode,
    setGlobalDefaultMode,
} from '../src/modes.js';

test('global default and per-chat mode are explicit and native is locked', () => {
    const settings = {};
    const global = ensureGlobalSettings(settings);
    assert.equal(global.defaultMode, DEFAULT_ENGINE_MODE);
    assert.equal(settings[SETTINGS_KEY].nativeLocked, true);
    setGlobalDefaultMode(settings, 'SHADOW');
    const metadata = {};
    assert.equal(getChatMode(metadata, settings), 'SHADOW');
    assert.equal(setChatMode(metadata, 'RECOVERY'), 'RECOVERY');
    assert.equal(metadata[CHAT_CONFIG_KEY].mode, 'RECOVERY');
    assert.equal(getChatMode(metadata, settings), 'RECOVERY');
    assert.equal(setChatMode(metadata, 'NATIVE'), 'LEGACY');
    assert.equal(getChatMode(metadata, settings), 'LEGACY');
    assert.deepEqual(ENGINE_MODES, ['LEGACY', 'SHADOW', 'NATIVE', 'RECOVERY']);
});

