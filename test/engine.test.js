import test from 'node:test';
import assert from 'node:assert/strict';
import { HostAdapter } from '../src/adapter.js';
import { ChatStore } from '../src/store.js';
import { STStateEngine } from '../src/engine.js';
import { exportLegacyState, importLegacyState } from '../src/legacy.js';
import { applyTransaction } from '../src/reducer.js';
import { setChatMode } from '../src/modes.js';
import { createEmptyState } from '../src/schema.js';

function setup() {
    const context = { chatId: 'chat', chatMetadata: {}, chat: [], extensionSettings: {}, setExtensionPrompt: (...args) => { context.injection = args; }, saveMetadata: async () => {}, saveChat: async () => {} };
    const adapter = new HostAdapter(() => context);
    const store = new ChatStore(adapter, { now: () => 5 });
    const engine = new STStateEngine({ adapter, store, now: () => 5 });
    const state = createEmptyState({ now: 1 }); state.actors = { US: { id: 'US', name: 'User' }, AL: { id: 'AL', name: 'Alice' } }; context.chatMetadata.stState = state; context.extensionSettings.stState = { defaultMode: 'SHADOW', enabled: true, diagnostics: true }; setChatMode(context.chatMetadata, 'SHADOW', { now: 1 });
    return { context, adapter, store, engine };
}

test('shadow imports authoritative legacy state and records matching candidate parity', async () => {
    const { context, engine, store } = setup();
    const authoritative = createEmptyState({ now: 5 }); authoritative.actors = { US: { id: 'US', name: 'User' }, AL: { id: 'AL', name: 'Alice' } }; authoritative.ct = 1; authoritative.meta.ct = 1; authoritative.scene.openBeat = 'door';
    const message = { is_user: false, mes: `Alice speaks ${exportLegacyState(authoritative)} <!--ST_PATCH {"version":2,"base":"GENESIS","mode":"NORMAL","tx":"t","ops":[{"op":"scene.set","set":{"openBeat":"door"}}]} -->` };
    const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: 'm' });
    assert.equal(result.status, 'shadow_match');
    assert.equal(message.mes, `Alice speaks ${exportLegacyState(authoritative)} `);
    assert.equal(store.load().ct, 1);
    assert.equal(message.extra.stState.status, 'shadow_match');
    assert.equal(message.extra.stState.patch.tx, 't');
    assert.equal(context.chatMetadata.stStateShadow.status, 'match');
});

test('legacy mode does not process controls, while shadow prompt includes handshake and pack', async () => {
    const { engine, context, store } = setup();
    setChatMode(context.chatMetadata, 'LEGACY');
    const message = { is_user: false, mes: 'ordinary <!--ST_PATCH {"version":2,"base":"GENESIS","mode":"NORMAL","ops":[]} -->' };
    const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: 'm' });
    assert.equal(result.status, 'legacy');
    assert.equal(store.load().ct, 0);
    assert.match(message.mes, /ST_PATCH/);
    setChatMode(context.chatMetadata, 'SHADOW');
    const injected = await engine.injectPrompt('normal', { userText: 'Alice' });
    assert.equal(injected.injected, true);
    assert.match(context.injection[1], /ST_STATE_HANDSHAKE v1/);
    assert.match(context.injection[1], /ST_LOCAL_FRAME/);
    assert.equal(context.injection[0], 'stState.hotState');
    assert.equal(context.injection[2], 1);
});

test('Hybrid Native commits an authoritative patch without a full legacy block', async () => {
    const { context, engine, store } = setup();
    setChatMode(context.chatMetadata, 'NATIVE');
    const message = { is_user: false, mes: 'Alice speaks <!--ST_PATCH\nV2\nbase=GENESIS\nmode=NORMAL\ntx=native-1\nscene.set|openBeat|The door opens\n-->' };
    const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: 'native-message' });
    assert.equal(result.status, 'native_committed');
    assert.equal(result.mode, 'NATIVE');
    assert.equal(result.persisted, true);
    assert.equal(store.load().ct, 1);
    assert.equal(store.load().scene.openBeat, 'The door opens');
    assert.equal(message.mes, 'Alice speaks ');
    assert.equal(message.extra.stState.status, 'native_committed');
    assert.equal(message.extra.stState.patch.tx, 'native-1');
    assert.equal(context.chatMetadata.stStateShadow, undefined);
});

test('Hybrid Native bootstraps first-turn user and card identities before prompt injection', async () => {
    const { context, engine, store } = setup();
    context.name1 = 'Janko Makar';
    context.name2 = 'Nicholas Snickerson';
    context.chatMetadata.stState = createEmptyState({ now: 1 });
    setChatMode(context.chatMetadata, 'NATIVE');
    const injected = await engine.injectPrompt('normal', { bootstrapNpcNames: ['Nicholas Snickerson'] });
    assert.equal(injected.injected, true);
    assert.equal(store.load().ct, 0);
    assert.equal(store.load().head, 'GENESIS');
    assert.equal(store.load().actors.US.name, 'Janko Makar');
    assert.equal(store.load().actors.NS.name, 'Nicholas Snickerson');
    assert.match(injected.text, /\"id\":\"US\"/);
    assert.match(injected.text, /\"id\":\"NS\"/);
    assert.match(injected.text, /including identity-only first-turn bootstrap rows/);

    const message = { is_user: false, mes: 'Visible <!--ST_PATCH\nV2\nbase=GENESIS\nmode=NORMAL\ntx=first-native\nactor.set|US|doing|Watching Nick unpack\nactor.set|NS|doing|Unpacking\nrelation.set|US|NS|bond|0\nscene.position|NS|By the bed\n-->' };
    const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: 'first-native-message' });
    assert.equal(result.status, 'native_committed');
    assert.equal(store.load().ct, 1);
    assert.equal(store.load().actors.NS.doing, 'Unpacking');
});

test('Hybrid Native merges only changed unsupported compatibility sections before its patch', async () => {
    const { context, engine, store } = setup();
    setChatMode(context.chatMetadata, 'NATIVE');
    const compatibility = '<internal_states><details><summary>🎬 INTERNAL STATES (Turn: 1)</summary><details><summary>🏳️ FACTIONS</summary>- <b>Guild</b> | Goal: Secure the gate | Intel: Open | Fibs: None | State: Alert | Conflict: None | Relations: Neutral</details></details></internal_states>';
    const message = { is_user: false, mes: `Visible prose ${compatibility} <!--ST_PATCH\nV2\nbase=GENESIS\nmode=NORMAL\ntx=native-compat\nscene.set|openBeat|The gate opens\n-->` };
    const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: 'native-compat-message' });
    assert.equal(result.status, 'native_committed');
    assert.equal(result.compatibility, true);
    assert.equal(store.load().scene.openBeat, 'The gate opens');
    assert.equal(Object.values(store.load().factions)[0].goal, 'Secure the gate');
    assert.doesNotMatch(message.mes, /internal_states|ST_PATCH|GFX_START|GFX_END/);
    assert.ok(result.diff.forward.some((change) => change.path.startsWith('factions.')));
});

test('Hybrid Native rejects malformed and stale patches without changing canonical state', async () => {
    for (const control of [
        '<!--ST_PATCH\nV2\nbase=GENESIS\nmode=NORMAL\nunknown|bad\n-->',
        '<!--ST_PATCH\nV2\nbase=wrong-head\nmode=NORMAL\ntx=stale\n-->',
    ]) {
        const { context, engine, store } = setup();
        setChatMode(context.chatMetadata, 'NATIVE');
        const before = store.load();
        const message = { is_user: false, mes: `Visible ${control}` };
        const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: `native-reject-${control.length}` });
        assert.match(result.status, /^native_(malformed|stale)$/);
        assert.deepEqual(store.load(), before);
        assert.doesNotMatch(message.mes, /ST_PATCH/);
    }
});

test('Hybrid Native freezes OOC, FLASH, and flash handoff', async () => {
    for (const route of ['OOC', 'FLASH']) {
        const { context, engine, store } = setup();
        setChatMode(context.chatMetadata, 'NATIVE');
        const before = store.load();
        const message = { is_user: false, mes: `Visible <!--ST_PATCH\nV2\nbase=GENESIS\nmode=${route}\ntx=native-${route}\n-->` };
        const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: `native-${route}` });
        assert.equal(result.status, 'ignored');
        assert.deepEqual(store.load(), before);
    }
    const { context, engine, store } = setup();
    setChatMode(context.chatMetadata, 'NATIVE');
    const before = store.load();
    const result = await engine.processAssistantMessage({ is_user: false, mes: 'Visible <flash_handoff target="ST-FLASH" />' }, { index: 0, messageIdentity: 'native-handoff' });
    assert.equal(result.status, 'ignored');
    assert.deepEqual(store.load(), before);
});

test('capabilities recognize the registered generation interceptor before the first turn', () => {
    const previous = globalThis.stStateGenerateInterceptor;
    globalThis.stStateGenerateInterceptor = () => undefined;
    try {
        const adapter = new HostAdapter(() => ({ chatMetadata: {}, extensionSettings: {} }));
        assert.equal(adapter.diagnostics().generationType, true);
    } finally {
        if (previous === undefined) delete globalThis.stStateGenerateInterceptor;
        else globalThis.stStateGenerateInterceptor = previous;
    }
});

test('shadow prompt injection waits for baseline when an existing chat has legacy state', async () => {
    const { context, engine } = setup();
    context.chatMetadata.stState = createEmptyState({ now: 1 });
    context.chat = [{ is_user: false, mes: exportLegacyState(createEmptyState({ now: 1 })) }];
    const result = await engine.injectPrompt('normal');
    assert.equal(result.injected, false);
    assert.equal(result.reason, 'baseline_required');
    assert.equal(context.injection[1], '');
});

test('shadow prompt injection blocks a stale selected-branch baseline', async () => {
    const { context, engine } = setup();
    const current = createEmptyState({ now: 1 }); current.ct = 4; current.meta.ct = 4;
    const currentRaw = exportLegacyState(current);
    context.chatMetadata.stState = importLegacyState(currentRaw, { now: 1, requireComplete: true }).state;
    const latest = createEmptyState({ now: 2 }); latest.ct = 5; latest.meta.ct = 5; latest.scene.openBeat = 'new branch';
    context.chat = [{ is_user: false, mes: exportLegacyState(latest) }];
    const result = await engine.injectPrompt('normal');
    assert.equal(result.injected, false);
    assert.equal(result.reason, 'baseline_stale');
    assert.equal(result.baseline.canonical.ct, 4);
    assert.equal(result.baseline.legacy.ct, 5);
    assert.equal(context.injection[1], '');
    assert.ok(engine.diagnostics.list().some((event) => event.code === 'BASELINE_STALE'));
});

test('shadow prompt injection accepts the exact latest selected-branch baseline', async () => {
    const { context, engine } = setup();
    const latest = createEmptyState({ now: 1 }); latest.ct = 4; latest.meta.ct = 4; latest.scene.openBeat = 'same branch';
    const raw = exportLegacyState(latest);
    context.chatMetadata.stState = importLegacyState(raw, { now: 1, requireComplete: true }).state;
    context.chat = [{ is_user: false, mes: raw }];
    const result = await engine.injectPrompt('normal');
    assert.equal(result.injected, true);
});

test('shadow prompt injection detects different branch content at the same ct', async () => {
    const { context, engine } = setup();
    const current = createEmptyState({ now: 1 }); current.ct = 4; current.meta.ct = 4; current.scene.openBeat = 'left branch';
    const currentRaw = exportLegacyState(current);
    context.chatMetadata.stState = importLegacyState(currentRaw, { now: 1, requireComplete: true }).state;
    const selected = createEmptyState({ now: 2 }); selected.ct = 4; selected.meta.ct = 4; selected.scene.openBeat = 'right branch';
    context.chat = [{ is_user: false, mes: exportLegacyState(selected) }];
    const result = await engine.injectPrompt('normal');
    assert.equal(result.reason, 'baseline_stale');
    assert.equal(result.baseline.canonical.ct, result.baseline.legacy.ct);
    assert.notEqual(result.baseline.canonical.head, result.baseline.legacy.head);
    assert.ok(engine.diagnostics.list().some((event) => /differs from the selected branch at ct 4/.test(event.message)));
});

test('OOC and FLASH remain frozen in shadow mode', async () => {
    const { engine, store } = setup();
    const before = store.load();
    for (const patchMode of ['OOC', 'FLASH']) {
        const message = { is_user: false, mes: `prose ${exportLegacyState({ ...before, ct: before.ct + 1 })} <!--ST_PATCH ${JSON.stringify({ version: 2, base: before.head, mode: patchMode, ops: [] })} -->` };
        const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: `freeze-${patchMode}` });
        assert.equal(result.status, 'ignored');
        assert.equal(store.load().ct, before.ct);
    }
});

test('persistence failure rolls canonical metadata back while hiding the control comment', async () => {
    const { context, engine, store } = setup();
    const before = store.load();
    context.saveMetadata = async () => { throw new Error('offline'); };
    const authoritative = createEmptyState({ now: 5 }); authoritative.actors = before.actors; authoritative.ct = 1; authoritative.meta.ct = 1; authoritative.scene.openBeat = 'must not persist';
    const message = { is_user: false, mes: `prose ${exportLegacyState(authoritative)} <!--ST_PATCH ${JSON.stringify({ version: 2, base: before.head, mode: 'NORMAL', tx: 'offline', ops: [{ op: 'scene.set', set: { openBeat: 'must not persist' } }] })} -->` };
    const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: 'offline-message' });
    assert.equal(result.status, 'persistence_error');
    assert.equal(store.load().ct, before.ct);
    assert.equal(store.load().scene.openBeat, before.scene.openBeat);
    assert.match(message.mes, /^prose /);
    assert.doesNotMatch(message.mes, /ST_PATCH/);
    assert.equal(message.extra.stState.status, 'persistence_error');
    assert.equal(message.extra.stState.patch.tx, 'offline');
    assert.equal(context.chatMetadata.stStateShadow, undefined);
});

test('complete legacy remains authoritative when the candidate is missing, malformed, or stale', async () => {
    for (const candidate of [
        '',
        '<!--ST_PATCH {not-json} -->',
        '<!--ST_PATCH {"version":2,"base":"wrong-head","mode":"NORMAL","tx":"stale","ops":[]} -->',
    ]) {
        const { context, engine, store } = setup();
        const authoritative = createEmptyState({ now: 5 });
        authoritative.actors = store.load().actors;
        authoritative.ct = 1; authoritative.meta.ct = 1; authoritative.scene.openBeat = 'authoritative';
        const message = { is_user: false, mes: `prose ${exportLegacyState(authoritative)} ${candidate}` };
        const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: `candidate-${candidate.length}` });
        assert.equal(result.status, 'shadow_not_comparable');
        assert.equal(store.load().ct, 1);
        assert.equal(store.load().scene.openBeat, 'authoritative');
        assert.equal(result.candidate, null);
        assert.equal(result.parity.status, 'not_comparable');
        assert.deepEqual(result.parity.mismatches, []);
        assert.doesNotMatch(message.mes, /ST_PATCH/);
        assert.equal(context.chatMetadata.stStateShadow.canonical.persisted, true);
    }
});

test('missing legacy or a legacy block without a turn header never changes canonical', async () => {
    for (const legacy of ['', '<internal_states><details><summary>🎬 INTERNAL STATES</summary><details><summary>👥 NPC STATE</summary>- None</details></details></internal_states>']) {
        const { engine, store } = setup();
        const before = store.load();
        const message = { is_user: false, mes: `prose ${legacy} <!--ST_PATCH {"version":2,"base":"GENESIS","mode":"NORMAL","tx":"reject","ops":[]} -->` };
        const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: `missing-${legacy.length}` });
        assert.equal(result.status, 'missing_legacy');
        assert.equal(store.load().ct, before.ct);
        assert.equal(store.load().head, before.head);
        assert.doesNotMatch(message.mes, /ST_PATCH/);
    }
});

test('partial live Shadow legacy advances while omitted sections carry forward', async () => {
    const { context, engine, store } = setup();
    const before = store.load();
    before.residue = [{ subject: 'Alice', event: 'Earlier event', meaning: 'Trust' }];
    before.thoughts = [{ actor: 'Alice', thoughts: 'Earlier thought' }];
    before.actors.BO = { id: 'BO', name: 'Bob', at: 'cold room', doing: 'sleeping' };
    before.scene.positions = { AL: 'old doorway', BO: 'cold room' };
    context.chatMetadata.stState = before;
    const partial = '<internal_states><details><summary>🎬 INTERNAL STATES (Turn: 1)</summary><details><summary>👥 NPC STATE</summary>- Alice | At: room | Doing: waiting | Agenda: None | VAD: 0/0/0 | Focus: door | Aware: room | Fibs: None | Circle: None | Body: well</details><details><summary>🌍 SCENE & WORLD</summary>- Spotlight: Alice | Open Beat: door opens | Time Pressure: None<br>- Env: room | Positions: Alice: by the door</details></details></internal_states>';
    const message = { is_user: false, mes: `prose ${partial}` };
    const result = await engine.processAssistantMessage(message, { index: 0, messageIdentity: 'partial-live' });
    assert.equal(result.status, 'shadow_not_comparable');
    assert.equal(store.load().ct, 1);
    assert.deepEqual(store.load().residue, before.residue);
    assert.deepEqual(store.load().thoughts, before.thoughts);
    assert.equal(store.load().actors.BO.doing, 'sleeping');
    assert.equal(store.load().scene.positions.AL, 'by the door');
    assert.equal(store.load().scene.positions.BO, 'cold room');
    assert.equal(result.parity.legacy.status, 'partial_accepted');
    assert.ok(result.parity.legacy.missingSections.includes('BONDS'));
    assert.ok(engine.diagnostics.list().some((entry) => entry.code === 'SHADOW_LEGACY_PARTIAL'));
});

test('replayed or out-of-order legacy turn cannot regress canonical state', async () => {
    const { engine, store } = setup();
    const first = createEmptyState({ now: 5 }); first.actors = store.load().actors; first.ct = 1; first.meta.ct = 1; first.scene.openBeat = 'first';
    await engine.processAssistantMessage({ is_user: false, mes: exportLegacyState(first) }, { index: 0, messageIdentity: 'first' });
    const replay = createEmptyState({ now: 6 }); replay.actors = first.actors; replay.ct = 1; replay.meta.ct = 1; replay.scene.openBeat = 'replay';
    const result = await engine.processAssistantMessage({ is_user: false, mes: exportLegacyState(replay) }, { index: 1, messageIdentity: 'replay' });
    assert.equal(result.status, 'legacy_sequence_mismatch');
    assert.equal(store.load().ct, 1);
    assert.equal(store.load().scene.openBeat, 'first');
});

