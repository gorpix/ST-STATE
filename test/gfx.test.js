import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractGfxProtocol,
    parseGfxProtocol,
    removeGfxControl,
    GFX_MEDIA_KINDS,
} from '../src/index.js';

const phone = `<!--ST_GFX
V1
kind=phone
mode=NORMAL
visibility=visible
platform=iphone
layout=chat
title=<b>Incoming</b> call
row|left|Mira|09:41|<i>Hello</i>
row|right|Me||I am here
-->`;

test('parses a hidden line protocol without JSON or DOM and keeps repeated rows', () => {
    const result = extractGfxProtocol(`Before ${phone} After`);
    assert.equal(result.ok, true);
    assert.equal(result.events.length, 1);
    const event = result.events[0];
    assert.equal(event.kind, 'phone');
    assert.equal(event.platform, 'ios');
    assert.equal(event.layout, 'chat');
    assert.equal(event.visibility, 'public');
    assert.equal(event.title, 'Incoming call');
    assert.deepEqual(event.rows, [
        { role: 'left', label: 'Mira', text: 'Hello', time: '09:41' },
        { role: 'right', label: 'Me', text: 'I am here' },
    ]);
    assert.match(event.id, /^gfx-[a-z0-9]+$/);
    assert.equal(result.prose, 'Before  After');
});

test('IDs are deterministic and content-sensitive', () => {
    const first = parseGfxProtocol('', 'V1\nkind=paper\nmode=NORMAL\nvisibility=visible\ntitle=Note\nrow=Hello');
    const again = parseGfxProtocol('', 'V1\nkind=paper\nmode=NORMAL\nvisibility=visible\ntitle=Note\nrow=Hello');
    const changed = parseGfxProtocol('', 'V1\nkind=paper\nmode=NORMAL\nvisibility=visible\ntitle=Note\nrow=Goodbye');
    assert.equal(first.ok, true);
    assert.equal(first.event.id, again.event.id);
    assert.notEqual(first.event.id, changed.event.id);
});

test('canonical rows retain delimiter characters in the trailing text field', () => {
    const parsed = parseGfxProtocol('', 'V1\nkind=terminal\nmode=NORMAL\nvisibility=visible\ntitle=Output\nrow|system|stdout||left|right');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.event.rows[0].text, 'left|right');
});

test('malformed and unsupported controls are safe while ordinary markup remains', () => {
    const source = '<b>visible</b><!--ST_GFX\nV1\nkind=unknown\nmode=NORMAL\nvisibility=visible\ntitle=x\nrow=y\n-->tail';
    const result = extractGfxProtocol(source);
    assert.equal(result.ok, false);
    assert.equal(result.events.length, 0);
    assert.equal(result.prose, '<b>visible</b>tail');
    assert.match(result.errors.join('; '), /Unsupported GFX media kind/);
    assert.equal(removeGfxControl('x <!--not gfx--> y'), 'x <!--not gfx--> y');
    assert.equal(removeGfxControl('x <!--GFX_PROTOCOL\nV1\n--> y'), 'x <!--GFX_PROTOCOL\nV1\n--> y');
});

test('bounds fields and rejects invalid phone variants', () => {
    const long = 'x'.repeat(2000);
    const result = parseGfxProtocol('', `V1\nkind=phone\nmode=NORMAL\nvisibility=visible\nplatform=windows\nlayout=chat\ntitle=${long}\nrow=${long}`);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('; '), /Invalid GFX phone platform/);
    assert.match(result.errors.join('; '), /GFX line exceeds maximum length/);
});

test('supported media kinds are explicit', () => {
    assert.deepEqual(GFX_MEDIA_KINDS.includes('phone'), true);
    assert.equal(GFX_MEDIA_KINDS.includes('html'), false);
});

test('rejects duplicate ST_GFX controls instead of silently choosing one', () => {
    const paper = '<!--ST_GFX\nV1\nkind=paper\nmode=NORMAL\nvisibility=visible\ntitle=Note\nrow=item\n-->';
    const result = extractGfxProtocol(`${paper}${paper}`);
    assert.equal(result.ok, false);
    assert.equal(result.events.length, 0);
    assert.match(result.errors.join('; '), /Only one ST_GFX control/);
    assert.equal(result.prose, '');
});
