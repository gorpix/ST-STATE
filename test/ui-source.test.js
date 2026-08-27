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
