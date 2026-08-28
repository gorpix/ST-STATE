import test from 'node:test';
import assert from 'node:assert/strict';
import { GfxOverlay, calculateGfxDuration, createGfxOverlay } from '../src/gfx-overlay.js';

class FakeClassList {
    constructor() { this.values = new Set(); }
    add(...values) { values.forEach((value) => this.values.add(value)); }
    toggle(value, force) {
        const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
        if (enabled) this.values.add(value); else this.values.delete(value);
        return enabled;
    }
    contains(value) { return this.values.has(value); }
}

class FakeElement {
    constructor(tag) {
        this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
        this.classList = new FakeClassList(); this.dataset = {}; this.attributes = {};
        this.hidden = false; this._text = '';
    }
    set className(value) { this._className = String(value); String(value).split(/\s+/).filter(Boolean).forEach((part) => this.classList.add(part)); }
    get className() { return this._className ?? ''; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentNode = this; } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    querySelector(selector) {
        if (selector.startsWith('#') && this.id === selector.slice(1)) return this;
        for (const child of this.children) { const found = child.querySelector?.(selector); if (found) return found; }
        return null;
    }
}

class FakeDocument {
    constructor() { this.body = new FakeElement('body'); this.documentElement = this.body; }
    createElement(tag) { return new FakeElement(tag); }
    querySelector(selector) { return this.body.querySelector(selector); }
}

function documentFixture() { return new FakeDocument(); }

test('renders a public artifact as text-only accessible card', () => {
    const documentRef = documentFixture();
    const overlay = createGfxOverlay({ document: documentRef, duration: 0 });
    const card = overlay.show({
        id: 'event-1', kind: 'paper', title: '<b>Letter</b>', source: 'Mira',
        rows: [{ label: 'Body', text: '<i>Do not open.</i>' }], visibility: 'public',
    });
    assert.ok(card);
    assert.equal(overlay.root.attributes.role, 'log');
    assert.equal(overlay.root.attributes['aria-live'], 'polite');
    assert.equal(card.attributes.role, 'group');
    assert.equal(card.attributes['aria-live'], undefined);
    assert.match(card.textContent, /<b>Letter<\/b>/);
    assert.match(card.textContent, /<i>Do not open\.<\/i>/);
    assert.equal(card.innerHTML, undefined);
    assert.equal(card.classList.contains('st-gfx-kind-paper'), true);
});

test('phone bubbles follow explicit row roles and retain timestamps as text', () => {
    const documentRef = documentFixture();
    const overlay = new GfxOverlay({ document: documentRef, duration: 0 });
    const card = overlay.show({ id: 'phone', kind: 'phone', platform: 'ios', layout: 'chat', title: 'Chat', rows: [
        { role: 'received', label: 'Mira', text: 'Hi', time: '09:41' },
        { role: 'sent', label: 'Me', text: 'Hello', time: '09:42' },
    ] });
    const rowsContainer = card.children[0].children.find((node) => node.className.includes('st-gfx-rows'));
    const rows = rowsContainer.children;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].classList.contains('st-gfx-row-role-received'), true);
    assert.equal(rows[1].classList.contains('st-gfx-row-role-sent'), true);
    assert.match(rows[0].textContent, /09:41/);
});

test('status-only phone metadata is rendered once and never restored below the contact', () => {
    const documentRef = documentFixture();
    const overlay = new GfxOverlay({ document: documentRef, duration: 0 });
    const card = overlay.show({
        id: 'android-status', kind: 'phone', platform: 'android', title: 'Chat', source: 'Niko',
        meta: { time: '09:41', battery: 'LTE 82%' }, rows: ['Hello'],
    });
    const frame = card.children[0];
    const status = frame.children.find((node) => node.className.includes('st-gfx-phone-status'));
    const meta = frame.children.find((node) => node.className === 'st-gfx-meta');
    assert.equal(status.textContent, '09:41LTE 82%');
    assert.equal(meta, undefined);
});

test('iOS status bar owns cellular, wifi, and battery geometry', () => {
    const documentRef = documentFixture();
    const overlay = new GfxOverlay({ document: documentRef, duration: 0 });
    const card = overlay.show({ id: 'ios-status', kind: 'phone', platform: 'ios', title: 'Messages', meta: { time: '09:41', battery: '87%' }, rows: ['Hello'] });
    const status = card.children[0].children.find((node) => node.className.includes('st-gfx-phone-status'));
    const indicators = status.children[1];
    assert.equal(indicators.children.some((node) => node.className === 'st-gfx-ios-cellular'), true);
    assert.equal(indicators.children.some((node) => node.className === 'st-gfx-ios-wifi'), true);
    assert.equal(indicators.children.some((node) => node.className === 'st-gfx-ios-battery'), true);
    assert.match(status.textContent, /09:41.*87/);
});

test('duration uses the setting as a floor and extends with visible message words', () => {
    const short = { rows: [{ role: 'received', text: 'Keep moving.' }] };
    const long = { rows: [{ role: 'received', text: Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ') }] };
    assert.equal(calculateGfxDuration(short, 7000), 7000);
    assert.equal(calculateGfxDuration(long, 7000), 12_500);
    assert.equal(calculateGfxDuration(long, 15_000), 15_000);
    assert.equal(calculateGfxDuration(long, 0), 0);
    assert.equal(calculateGfxDuration({ rows: [{ text: 'word '.repeat(400) }] }, 7000), 45_000);
});

test('deduplicates IDs, bounds visible cards, and replaces branches', () => {
    const documentRef = documentFixture();
    const overlay = new GfxOverlay({ document: documentRef, maxVisible: 2, duration: 0, branchId: 'a' });
    const first = overlay.show({ id: 'same', kind: 'map', title: 'Map', rows: ['one'] });
    assert.equal(overlay.show({ id: 'same', kind: 'map', title: 'Duplicate', rows: ['two'] }), first);
    overlay.show({ id: 'two', kind: 'map', title: 'Two', rows: ['two'] });
    overlay.show({ id: 'three', kind: 'map', title: 'Three', rows: ['three'] });
    assert.equal(overlay.cards.size, 2);
    overlay.replaceBranch('b', [{ id: 'new', kind: 'phone', platform: 'android', layout: 'notification', title: 'Ping', rows: ['hello'] }]);
    assert.equal(overlay.branchId, 'b');
    assert.equal(overlay.cards.size, 1);
    assert.equal(overlay.cards.get('new').classList.contains('st-gfx-phone-android'), true);
});

test('disabled and non-public events never render; branch identity can auto-clear', () => {
    const documentRef = documentFixture();
    const disabled = new GfxOverlay({ document: documentRef, enabled: false });
    assert.equal(disabled.show({ id: 'x', kind: 'notice', title: 'No', rows: ['x'] }), null);
    const overlay = new GfxOverlay({ document: documentRef, duration: 0 });
    assert.equal(overlay.show({ id: 'private', kind: 'phone', title: 'Hidden', rows: ['x'], visibility: 'private' }), null);
    overlay.show({ id: 'a', branchId: 'one', kind: 'phone', platform: 'ios', title: 'A', rows: ['a'] });
    overlay.show({ id: 'b', branchId: 'two', kind: 'phone', platform: 'ios', title: 'B', rows: ['b'] });
    assert.equal(overlay.cards.size, 1);
    assert.equal(overlay.cards.has('a'), false);
});
