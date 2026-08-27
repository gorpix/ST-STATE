import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('settings panel uses the SillyTavern delegated inline-drawer contract', async () => {
    const source = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');
    assert.match(source, /inline-drawer-toggle inline-drawer-header/);
    assert.match(source, /inline-drawer-icon fa-solid fa-circle-chevron-down down interactable/);
    assert.match(source, /Candidate errors/);
    assert.doesNotMatch(source, /element\('details', 'inline-drawer'\)/);
});

test('settings panel exposes confirmation-gated recovery controls and callback hooks', async () => {
    const source = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');
    for (const label of ['Rebaseline selected branch', 'Clear current chat state', 'Restore previous state']) assert.match(source, new RegExp(label));
    for (const callback of ['onRebaselineSelectedBranch', 'onClearCurrentChatState', 'onRestorePreviousState']) assert.match(source, new RegExp(callback));
    assert.match(source, /st-state-pre-rebaseline-backup\.json/);
    assert.match(source, /st-state-pre-clear-backup\.json/);
    assert.match(source, /st-state-pre-restore-backup\.json/);
    for (const operation of ['rebaseline-selected-branch', 'clear-current-chat-state', 'restore-previous-state']) assert.match(source, new RegExp(operation));
    assert.match(source, /backupText/);
    assert.match(source, /globalThis\.confirm\?\./);
    assert.match(source, /aria-live/);
});

test('settings panel exposes local GFX controls and both phone previews', async () => {
    const source = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');
    for (const label of ['Local pop-in GFX', 'Preview iPhone-like', 'Preview Android-like']) assert.match(source, new RegExp(label));
    for (const callback of ['getGfxSettings', 'setGfxSettings', 'onPreviewGfx']) assert.match(source, new RegExp(callback));
    assert.match(source, /durationMs/);
});
