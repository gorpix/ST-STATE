import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessageReceived, renderLocalGfx, runtimeState } from '../src/main.js';

const control = `<!--ST_GFX
V1
kind=phone
mode=NORMAL
visibility=visible
platform=android
layout=chat
title=Messages
row|received|Mira|09:41|Keep the line open.
-->`;

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

test('local GFX binds to the selected swipe, caches sanitized data, and strips only that swipe control', async () => {
    const calls = [];
    let saves = 0;
    const text = `Visible reply\n${control}`;
    const message = { mes: text, swipes: [text, `Other reply\n${control.replace('Mira', 'Niko')}`], swipe_id: 0, extra: {} };
    runtimeState.adapter = {
        getChatId: () => 'chat-a',
        getSettings: () => ({ stState: { gfxEnabled: true, gfxDurationMs: 7000 } }),
        saveChat: async () => { saves += 1; },
    };
    runtimeState.engine = { getMode: () => 'SHADOW', diagnostics: { warn: () => {} } };
    runtimeState.gfxOverlay = {
        configure: () => {},
        replaceBranch: (branchId, events) => calls.push({ branchId, events }),
    };
    try {
        const first = await renderLocalGfx(message, 4);
        assert.equal(first.status, 'rendered');
        assert.equal(first.event.platform, 'android');
        assert.doesNotMatch(message.mes, /ST_GFX/);
        assert.doesNotMatch(message.swipes[0], /ST_GFX/);
        assert.match(message.swipes[1], /ST_GFX/);
        assert.equal(saves, 1);
        assert.equal(Object.keys(message.extra.stStateGfx).length, 1);

        const replay = await renderLocalGfx(message, 4);
        assert.equal(replay.status, 'rendered');
        assert.equal(saves, 1);
        assert.equal(calls.at(-1).events[0].rows[0].text, 'Keep the line open.');

        message.swipe_id = 2;
        const pending = await renderLocalGfx(message, 4);
        assert.equal(pending.status, 'empty');
        assert.deepEqual(calls.at(-1).events, []);
    } finally { resetRuntime(); }
});

test('cleanup persistence is chat-guarded and failure is surfaced', async () => {
    let saves = 0;
    const text = `Visible reply\n${control}`;
    const message = { mes: text, swipe_id: 0, extra: {} };
    runtimeState.adapter = {
        getChatId: () => 'chat-save-failure',
        getSettings: () => ({ stState: {} }),
        saveChat: async ({ expectedChatId }) => {
            saves += 1;
            assert.equal(expectedChatId, 'chat-save-failure');
            throw new Error('offline');
        },
    };
    runtimeState.engine = { getMode: () => 'SHADOW', diagnostics: { warn: () => {} } };
    runtimeState.gfxOverlay = { configure: () => {}, clear: () => {}, replaceBranch: () => assert.fail('must not render') };
    try {
        const result = await renderLocalGfx(message, 2, { expectedChatId: 'chat-save-failure' });
        assert.equal(result.status, 'persistence_error');
        assert.equal(saves, 1);
        assert.match(message.mes, /ST_GFX/);
        assert.equal(message.extra.stStateGfx, undefined);
    } finally { resetRuntime(); }
});

test('chat switch during GFX save rolls back cleanup and never renders', async () => {
    let saves = 0;
    const text = `Visible reply\n${control}`;
    const message = { mes: text, swipes: [text], swipe_id: 0, extra: {} };
    runtimeState.adapter = {
        getChatId: () => saves ? 'chat-new' : 'chat-old',
        getSettings: () => ({ stState: {} }),
        saveChat: async () => { saves += 1; },
    };
    runtimeState.engine = { getMode: () => 'SHADOW', diagnostics: { warn: () => {} } };
    runtimeState.gfxOverlay = { configure: () => {}, clear: () => {}, replaceBranch: () => assert.fail('must not render') };
    try {
        const result = await renderLocalGfx(message, 2, { expectedChatId: 'chat-old' });
        assert.equal(result.status, 'persistence_error');
        assert.match(message.mes, /ST_GFX/);
        assert.equal(message.swipes[0], text);
        assert.equal(message.extra.stStateGfx, undefined);
    } finally { resetRuntime(); }
});

test('malformed local GFX is stripped and never rendered', async () => {
    const calls = [];
    const message = { mes: 'Visible<!--ST_GFX\nV1\nkind=phone\n-->', swipe_id: 0 };
    runtimeState.adapter = {
        getChatId: () => 'chat-b',
        getSettings: () => ({ stState: {} }),
        saveChat: async () => {},
    };
    runtimeState.engine = { getMode: () => 'SHADOW', diagnostics: { warn: () => {} } };
    runtimeState.gfxOverlay = { configure: () => {}, replaceBranch: (branchId, events) => calls.push({ branchId, events }) };
    try {
        const result = await renderLocalGfx(message, 2);
        assert.equal(result.status, 'rejected');
        assert.equal(message.mes, 'Visible');
        assert.deepEqual(calls.at(-1).events, []);
    } finally { resetRuntime(); }
});

test('LEGACY and RECOVERY never parse, cache, strip, or render local GFX', async () => {
    for (const mode of ['LEGACY', 'RECOVERY']) {
        let overlayCalls = 0;
        const text = `Visible reply\n${control}`;
        const message = { mes: text, swipe_id: 0, extra: {} };
        runtimeState.adapter = { getChatId: () => 'chat-mode', getSettings: () => ({ stState: {} }) };
        runtimeState.engine = { getMode: () => mode, diagnostics: { warn: () => {} } };
        runtimeState.gfxOverlay = { configure: () => {}, replaceBranch: () => { overlayCalls += 1; } };
        try {
            const result = await renderLocalGfx(message, 1, { expectedChatId: 'chat-mode' });
            assert.equal(result.status, 'ignored');
            assert.equal(message.mes, text);
            assert.equal(message.extra.stStateGfx, undefined);
            assert.equal(overlayCalls, 0);
        } finally { resetRuntime(); }
    }
});

test('failed or frozen Shadow results clear overlays without consuming ST_GFX', async () => {
    for (const engineResult of [
        { status: 'persistence_error', mode: 'SHADOW', persisted: false },
        { status: 'legacy_sequence_mismatch', mode: 'SHADOW', persisted: false },
        { status: 'ignored', mode: 'SHADOW', persisted: false },
    ]) {
        let clears = 0;
        let saves = 0;
        const text = `Visible reply\n${control}`;
        const message = { is_user: false, mes: text, swipe_id: 0, extra: {} };
        runtimeState.adapter = {
            getChat: () => [message],
            getChatId: () => 'chat-result',
            getSettings: () => ({ stState: {} }),
            saveChat: async () => { saves += 1; },
        };
        runtimeState.store = { load: () => ({}) };
        runtimeState.engine = {
            getMode: () => 'SHADOW',
            processAssistantMessage: async () => engineResult,
            diagnostics: { warn: () => {} },
        };
        runtimeState.gfxOverlay = { clear: () => { clears += 1; }, configure: () => {}, replaceBranch: () => assert.fail('must not render') };
        try {
            const result = await handleMessageReceived({ messageId: 0 });
            assert.equal(result.status, engineResult.status);
            assert.equal(message.mes, text);
            assert.equal(message.extra.stStateGfx, undefined);
            assert.equal(saves, 0);
            assert.equal(clears, 1);
        } finally { resetRuntime(); }
    }
});

test('chat identity mismatch prevents GFX mutation and rendering', async () => {
    let overlayCalls = 0;
    const text = `Visible reply\n${control}`;
    const message = { mes: text, swipe_id: 0, extra: {} };
    runtimeState.adapter = { getChatId: () => 'chat-new', getSettings: () => ({ stState: {} }) };
    runtimeState.engine = { getMode: () => 'SHADOW', diagnostics: { warn: () => {} } };
    runtimeState.gfxOverlay = { configure: () => {}, replaceBranch: () => { overlayCalls += 1; } };
    try {
        const result = await renderLocalGfx(message, 1, { expectedChatId: 'chat-old' });
        assert.equal(result.status, 'chat_changed');
        assert.equal(message.mes, text);
        assert.equal(message.extra.stStateGfx, undefined);
        assert.equal(overlayCalls, 0);
    } finally { resetRuntime(); }
});
