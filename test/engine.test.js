import test from 'node:test';
import assert from 'node:assert/strict';
import { HostAdapter } from '../src/adapter.js';
import { ChatStore } from '../src/store.js';
import { FF5Engine } from '../src/engine.js';
import { createEmptyState } from '../src/schema.js';

function setup() {
    const context = { chatId: 'chat', chatMetadata: {}, chat: [], extensionSettings: {}, setExtensionPrompt: (...args) => { context.injection = args; }, saveMetadata: async () => {}, saveChat: async () => {} };
    const adapter = new HostAdapter(() => context);
    const store = new ChatStore(adapter, { now: () => 5 });
    const engine = new FF5Engine({ adapter, store, now: () => 5 });
    const state = createEmptyState({ now: 1 }); state.actors = { US: { id: 'US', name: 'User' }, AL: { id: 'AL', name: 'Alice' } }; context.chatMetadata.ff5Engine = state;
    return { context, adapter, store, engine };
}

test('engine commits one valid message, removes hidden comment only after persistence, and rejects missing patch safely', async () => {
    const { context, engine, store } = setup();
    const message = { is_user: false, mes: `Alice speaks <!--FF5_PATCH {"version":2,"base":"GENESIS","mode":"NORMAL","tx":"t","ops":[{"op":"scene.set","set":{"openBeat":"door"}}]} -->` };
    const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: 'm' });
    assert.equal(result.status, 'committed');
    assert.equal(message.mes, 'Alice speaks ');
    assert.equal(store.load().ct, 1);
    assert.equal(message.extra.ff5Engine.status, 'committed');
    assert.equal(message.extra.ff5Engine.patch.tx, 't');
    const missing = await engine.processAssistantMessage({ is_user: false, mes: 'ordinary prose' }, { index: 1, messageIdentity: 'm2' });
    assert.equal(missing.status, 'missing');
    assert.equal(store.load().ct, 1);
    assert.ok(context.chatMetadata.ff5Engine.history.length === 1);
});

test('engine flash handoff overrides attempted NORMAL and prompt injection is compact', async () => {
    const { engine, context, store } = setup();
    const message = { is_user: false, mes: `flash <flash_handoff reason="local"/> <!--FF5_PATCH {"version":2,"base":"GENESIS","mode":"NORMAL","ops":[{"op":"scene.set","set":{"openBeat":"bad"}}]} -->` };
    const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: 'm' });
    assert.equal(result.status, 'ignored');
    assert.equal(store.load().ct, 0);
    assert.equal(message.mes, 'flash  ');
    const injected = await engine.injectPrompt('normal', { userText: 'Alice' });
    assert.equal(injected.injected, true);
    assert.match(context.injection[1], /FF5_STATE_PACK/);
    assert.equal(context.injection[0], 'ff5Engine.hotState');
    assert.equal(context.injection[2], 1);
});

test('persistence failure rolls canonical metadata back while hiding the control comment', async () => {
    const { context, engine, store } = setup();
    const before = store.load();
    context.saveMetadata = async () => { throw new Error('offline'); };
    const message = { is_user: false, mes: `prose <!--FF5_PATCH ${JSON.stringify({ version: 2, base: before.head, mode: 'NORMAL', tx: 'offline', ops: [{ op: 'scene.set', set: { openBeat: 'must not persist' } }] })} -->` };
    const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: 'offline-message' });
    assert.equal(result.status, 'persistence_error');
    assert.equal(store.load().ct, before.ct);
    assert.equal(store.load().scene.openBeat, before.scene.openBeat);
    assert.equal(message.mes, 'prose ');
    assert.equal(message.extra.ff5Engine.status, 'persistence_error');
    assert.equal(message.extra.ff5Engine.patch.tx, 'offline');
});

test('fifty sequential valid NORMAL turns produce fifty commits with no loss', async () => {
    const { engine, store } = setup();
    for (let index = 0; index < 50; index += 1) {
        const current = store.load();
        const message = { is_user: false, mes: `turn ${index} <!--FF5_PATCH ${JSON.stringify({ version: 2, base: current.head, mode: 'NORMAL', tx: `t-${index}`, ops: [{ op: 'scene.set', set: { openBeat: `beat-${index}` } }] })} -->` };
        const result = await engine.processAssistantMessage(message, { index, messageIdentity: `message-${index}` });
        assert.equal(result.status, 'committed');
    }
    assert.equal(store.load().ct, 50);
    assert.equal(store.load().history.length, 50);
    assert.equal(store.load().scene.openBeat, 'beat-49');
});

