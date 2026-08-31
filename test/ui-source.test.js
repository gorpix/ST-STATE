import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requestGfxPreview } from '../src/ui.js';

test('GFX gallery dispatches phone skins as a canonical phone selection', () => {
    const calls = [];
    requestGfxPreview((...args) => calls.push(args), 'ios');
    requestGfxPreview((...args) => calls.push(args), 'android');
    requestGfxPreview((...args) => calls.push(args), 'map');
    assert.deepEqual(calls, [
        ['phone', { platform: 'ios' }],
        ['phone', { platform: 'android' }],
        ['map'],
    ]);
});

test('settings panel uses the SillyTavern delegated inline-drawer contract', async () => {
    const source = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');
    assert.match(source, /inline-drawer-toggle inline-drawer-header/);
    assert.match(source, /inline-drawer-icon fa-solid fa-circle-chevron-down down interactable/);
    assert.match(source, /Candidate errors/);
    assert.match(source, /SHADOW SUCCESS/);
    assert.match(source, /st-parity-success/);
    assert.match(source, /Candidate committed/);
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
    assert.match(source, /preserveMissingFromBase:\s*true/);
    assert.match(source, /Preserved missing sections/);
});

test('settings panel exposes local GFX controls and both phone previews', async () => {
    const source = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');
    for (const label of ['Local pop-in GFX', 'Minimum duration', 'Preview kind', 'Preview selected GFX', 'Preview iPhone-like', 'Preview Android-like']) assert.match(source, new RegExp(label));
    for (const callback of ['getGfxSettings', 'setGfxSettings', 'onPreviewGfx']) assert.match(source, new RegExp(callback));
    assert.match(source, /durationMs/);
    assert.match(source, /GFX_MEDIA_KINDS/);
});

test('successful Shadow parity is styled as a live status result', async () => {
    const uiSource = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');
    const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
    const cssSource = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(uiSource, /aria-live/);
    assert.match(mainSource, /renderShadowParity\(runtimeState\.ui\.parity/);
    assert.match(mainSource, /parity:\s*settingsRoot\.querySelector\('\.st-shadow-parity'\)/);
    assert.match(cssSource, /\.st-shadow-parity\.st-parity-success/);
});

test('phone skins retain a fixed device ratio with a scrolling content viewport', async () => {
    const source = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(source, /aspect-ratio:\s*9\s*\/\s*19\.5/);
    assert.match(source, /\.st-gfx-phone-rows[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
    assert.match(source, /width:\s*min\(18rem, 100%, calc\(46\.1538dvh - 2\.54rem\)\)/);
});

test('local GFX exposes a persistent accessible phone launcher', async () => {
    const overlaySource = await readFile(new URL('../src/gfx-overlay.js', import.meta.url), 'utf8');
    const cssSource = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(overlaySource, /GFX_PHONE_LAUNCHER_ID/);
    assert.match(overlaySource, /aria-pressed/);
    assert.match(overlaySource, /togglePhone\(\)/);
    assert.match(cssSource, /\.st-gfx-phone-launcher/);
});

test('read-only dashboard has a persistent launcher beside the phone button', async () => {
    const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
    const cssSource = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(mainSource, /QUICK_DASHBOARD_LAUNCHER_ID/);
    assert.match(mainSource, /Open ST-STATE dashboard/);
    assert.match(mainSource, /toggleQuickDashboard/);
    assert.match(mainSource, /renderReadOnlyDashboard\(quick\.content/);
    assert.match(mainSource, /const ready = \(\) => \{[\s\S]*ensureQuickDashboard\(\)/);
    assert.match(mainSource, /runtimeState\.quickDashboard && runtimeState\.quickDashboard\.launcher/);
    assert.doesNotMatch(mainSource, /if \(typeof document === 'undefined' \|\| !runtimeState\.ui \|\| !runtimeState\.store\) return null/);
    assert.match(cssSource, /\.st-state-dashboard-launcher[^}]*right:\s*4\.25rem/s);
    assert.match(cssSource, /\.st-state-quick-dashboard-panel/);
    assert.match(cssSource, /\.st-state-quick-dashboard-panel \.st-dashboard-digest \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(cssSource, /\.st-state-quick-dashboard-panel \.st-card-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
});

test('runtime refresh synchronizes mode selectors after chat metadata changes', async () => {
    const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
    assert.match(source, /querySelector\?\.\('\[aria-label="ST-STATE chat mode"\]'\)/);
    assert.match(source, /mode\.value = runtimeState\.engine\?\.getMode\?\.\(\)/);
    assert.match(source, /defaultMode\.value = getGlobalDefaultMode/);
});

test('Android phone skin has geometric status icons and high-contrast message surfaces', async () => {
    const source = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    for (const selector of ['st-gfx-android-cellular', 'st-gfx-android-wifi', 'st-gfx-android-battery']) assert.match(source, new RegExp(`\\.${selector}`));
    assert.match(source, /\.st-gfx-phone-android \.st-gfx-row-role-received[^}]*background:\s*#27323b[^}]*color:\s*#f5f7f9/s);
    assert.match(source, /\.st-gfx-phone-android \.st-gfx-row-role-sent[^}]*background:\s*#0b57d0[^}]*color:\s*#fff/s);
});

test('iPhone skin uses high-contrast dark Messages surfaces', async () => {
    const source = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(source, /\.st-gfx-phone-status-ios[^}]*background:\s*#000[^}]*color:\s*#f5f5f7/s);
    assert.match(source, /\.st-gfx-phone-ios \.st-gfx-row-role-received[^}]*background:\s*#2c2c2e[^}]*color:\s*#fff/s);
    assert.match(source, /\.st-gfx-phone-ios \.st-gfx-row-role-sent[^}]*background:\s*#0a84ff[^}]*color:\s*#fff/s);
    assert.match(source, /\.st-gfx-phone-shell\.st-gfx-phone-ios::after/);
});

test('the local stylesheet has a distinct shell for every non-phone media kind', async () => {
    const source = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    for (const kind of ['terminal', 'paper', 'map', 'notice', 'credential', 'transaction', 'web', 'broadcast', 'data', 'image', 'monitor', 'media']) {
        assert.match(source, new RegExp(`\\.st-gfx-(?:card\\.)?st-gfx-kind-${kind}|\\.st-gfx-kind-${kind}`), kind);
    }
    assert.match(source, /\.st-gfx-card:not\(\.st-gfx-kind-phone\)[^}]*max-height:[^}]+/s);
    assert.match(source, /\.st-gfx-card:not\(\.st-gfx-kind-phone\) \.st-gfx-rows[^}]*overflow-y:\s*auto/s);
    assert.match(source, /st-gfx-row-role-warning/);
});
