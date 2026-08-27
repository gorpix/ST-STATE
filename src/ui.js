import { exportLegacyState, importLegacyState } from './legacy.js';
import { stateSummary } from './schema.js';
import { deepClone, sanitizePlainText } from './util.js';
import { ENGINE_MODES, SELECTABLE_MODES, NATIVE_MODE_LOCKED } from './modes.js';

function element(tag, className = '', text = undefined) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function appendLabelValue(parent, label, value) {
    const row = element('div', 'st-kv');
    row.append(element('span', 'st-kv-label', label), element('span', 'st-kv-value', value ?? 'None'));
    parent.append(row);
    return row;
}

function stringValue(value) {
    if (Array.isArray(value)) return value.length ? value.join(', ') : 'None';
    if (value && typeof value === 'object') return JSON.stringify(value);
    return value === undefined || value === null || value === '' ? 'None' : String(value);
}

function section(title, content, { open = false, className = '' } = {}) {
    const details = element('details', `st-section ${className}`);
    details.open = open;
    const summary = element('summary', 'st-section-title', title);
    details.append(summary, content);
    return details;
}

function listContent(items) {
    const wrapper = element('div', 'st-list');
    if (!Array.isArray(items) || items.length === 0) wrapper.append(element('div', 'st-empty', 'None'));
    else for (const item of items) wrapper.append(element('div', 'st-list-item', typeof item === 'string' ? item : stringValue(item)));
    return wrapper;
}

function actorCard(actor, id) {
    const card = element('article', 'st-actor-card');
    const heading = element('h4', '', `${actor?.name ?? id} `);
    heading.append(element('code', 'st-actor-id', id));
    card.append(heading);
    for (const [label, value] of [['At', actor?.at ?? actor?.location ?? actor?.position], ['Doing', actor?.doing ?? actor?.activity], ['Agenda', actor?.agenda], ['VAD', [actor?.valence, actor?.arousal, actor?.dominance].every((item) => typeof item === 'number') ? `${actor.valence}/${actor.arousal}/${actor.dominance}` : undefined], ['Focus', actor?.focus], ['Aware', actor?.aware], ['Fibs', actor?.fibs], ['Circle', actor?.circle], ['Body', actor?.body]]) appendLabelValue(card, label, stringValue(value));
    return card;
}

function relationCard(relation, state) {
    const card = element('article', 'st-relation-card');
    const labelA = relation.labelA || state.actors?.[relation.a]?.name || relation.a;
    const labelB = relation.labelB || state.actors?.[relation.b]?.name || relation.b;
    card.append(element('h4', '', `${labelA} ↔ ${labelB}`));
    const metrics = [['BOND', relation.bond, -5, 20, 'st-bond'], ['SPARKS', relation.sparks, 0, 20, 'st-sparks'], ['GRUDGE', relation.grudge, 0, 20, 'st-grudge']];
    for (const [label, value, min, max, className] of metrics) {
        const row = element('div', 'st-meter-row');
        row.append(element('span', 'st-meter-label', `${label} ${value ?? 0}`));
        const meter = element('meter', `st-meter ${className}`);
        meter.min = min; meter.max = max; meter.value = Math.max(min, Math.min(max, Number(value) || 0));
        meter.setAttribute('aria-label', `${label} ${value ?? 0}`);
        row.append(meter); card.append(row);
    }
    const profiles = relation.profile ? Object.values(relation.profile) : [];
    for (const profile of profiles) {
        const profileBox = element('div', 'st-profile');
        const from = state.actors?.[profile.from]?.name || profile.from;
        const to = state.actors?.[profile.to]?.name || profile.to;
        profileBox.append(element('strong', '', `Profile ${from} → ${to}`));
        for (const [key, value] of [['Type', profile.type], ['Route', profile.route], ['Trust', profile.trust], ['Attraction', profile.attraction], ['Expect', profile.expect], ['Public', profile.public], ['Private', profile.private], ['Jealousy', profile.jealousy], ['Boundary', profile.boundary], ['Anchors', profile.anchors]]) appendLabelValue(profileBox, key, stringValue(value));
        card.append(profileBox);
    }
    return card;
}

function renderHistory(state) {
    const wrapper = element('div', 'st-history');
    if (!state.history?.length) return listContent([]);
    for (const entry of [...state.history].reverse()) {
        const item = element('details', 'st-history-item');
        item.append(element('summary', '', `ct ${entry.ct} · ${entry.summary || entry.transactionId || 'NORMAL commit'}`));
        const body = element('div', 'st-history-body');
        appendLabelValue(body, 'Head', `${entry.base ?? '?'} → ${entry.head ?? '?'}`);
        appendLabelValue(body, 'Message', entry.messageId || 'unknown');
        appendLabelValue(body, 'Transaction', entry.transactionId || 'unknown');
        const changes = entry.diff?.forward ?? [];
        appendLabelValue(body, 'Changes', changes.length ? changes.map((change) => change.path).join(', ') : 'None');
        item.append(body); wrapper.append(item);
    }
    return wrapper;
}

/** Render all state sections with textContent-only model values. */
export function renderReadOnlyDashboard(container, inputState, { openSections = [], includeHistory = true } = {}) {
    if (!container || typeof document === 'undefined') return null;
    const state = deepClone(inputState ?? {});
    container.replaceChildren();
    container.classList.add('st-dashboard');
    const summary = stateSummary(state);
    const header = element('div', 'st-dashboard-header');
    header.append(element('h3', '', 'ST-STATE'), element('span', 'st-status-pill', `ct ${summary.ct}`));
    const digest = element('div', 'st-dashboard-digest');
    appendLabelValue(digest, 'Head', summary.head);
    appendLabelValue(digest, 'Actors', summary.actors);
    appendLabelValue(digest, 'Relations', summary.relations);
    appendLabelValue(digest, 'Schema', summary.schemaVersion);
    container.append(header, digest);

    const actorGrid = element('div', 'st-card-grid');
    for (const [id, actor] of Object.entries(state.actors ?? {})) actorGrid.append(actorCard(actor, id));
    container.append(section('👥 Actors', actorGrid, { open: openSections.includes('actors') }));

    const scene = element('div', 'st-content');
    appendLabelValue(scene, 'Spotlight', stringValue(state.scene?.spotlight));
    appendLabelValue(scene, 'Open beat', state.scene?.openBeat);
    appendLabelValue(scene, 'Time pressure', state.scene?.timePressure);
    appendLabelValue(scene, 'Environment', state.scene?.environment);
    appendLabelValue(scene, 'Positions', stringValue(state.scene?.positions));
    appendLabelValue(scene, 'Time', state.scene?.time);
    container.append(section('🌌 Scene & world', scene, { open: true }));

    const relationGrid = element('div', 'st-card-grid st-relation-grid');
    for (const relation of Object.values(state.relations?.pairs ?? {})) relationGrid.append(relationCard(relation, state));
    container.append(section('💚 Relations & profiles', relationGrid, { open: openSections.includes('relations') }));

    const factionGrid = element('div', 'st-card-grid');
    for (const faction of Object.values(state.factions ?? {})) {
        const card = element('article', 'st-actor-card'); card.append(element('h4', '', faction.name || 'Faction'));
        for (const [label, value] of [['Goal', faction.goal], ['Intel', faction.intel], ['Fibs', faction.fibs], ['State', faction.state], ['Conflict', faction.conflict], ['Relations', faction.relations]]) appendLabelValue(card, label, stringValue(value));
        factionGrid.append(card);
    }
    container.append(section('🏳️ Factions', factionGrid));
    const residue = listContent(state.residue); container.append(section('🧩 Emotional residue', residue));
    const quests = listContent(state.quests); container.append(section('📜 Quests', quests));
    const inventory = element('div', 'st-content');
    for (const [label, value] of [['Inventory', state.inventory?.items], ['Titles / skills', state.inventory?.titlesSkills], ['Status', state.inventory?.status], ['Modifiers', state.inventory?.modifiers]]) appendLabelValue(inventory, label, stringValue(value));
    container.append(section('🎒 Inventory & skills', inventory));
    const chekhov = element('div', 'st-content');
    for (const [label, value] of [['Active', state.chekhov?.active], ['Locked', state.chekhov?.locked], ['Fired', state.chekhov?.fired]]) appendLabelValue(chekhov, label, stringValue(value));
    container.append(section("🔫 Chekhov's gun", chekhov));
    container.append(section('🧠 Thoughts', listContent(state.thoughts)));
    container.append(section("📓 GM's notebook", listContent(state.notebook)));
    container.append(section('🎲 Last DND check', listContent(state.lastDnd ? [state.lastDnd] : [])));
    container.append(section('🕰️ Clocks', listContent(state.clocks)));
    container.append(section('🗺️ Knowledge', listContent(state.knowledge)));
    container.append(section('🤝 Commitments', listContent(state.commitments)));
    container.append(section('🧱 Artifacts', listContent(state.artifacts)));
    container.append(section('🌎 World Sim (opaque)', listContent(state.worldSim?.raw ? [state.worldSim.raw] : [])));
    container.append(section('🗃️ Opaque legacy data', listContent(Object.values(state.opaque?.legacy?.sections ?? {}))));
    if (includeHistory) container.append(section('🧾 Commit history & diffs', renderHistory(state), { open: openSections.includes('history') }));
    return container;
}

export const renderDashboard = renderReadOnlyDashboard;

export function renderDiagnostics(container, diagnostics) {
    if (!container || typeof document === 'undefined') return null;
    container.replaceChildren();
    const table = element('div', 'st-diagnostics');
    for (const [key, value] of Object.entries(diagnostics ?? {})) {
        const row = element('div', 'st-diagnostic-row');
        row.append(element('span', '', key), element('span', value ? 'st-ok' : 'st-warning', value ? 'available' : 'unavailable'));
        table.append(row);
    }
    container.append(table);
    return table;
}

export function renderDiagnosticEvents(container, entries = []) {
    if (!container || typeof document === 'undefined') return null;
    container.replaceChildren();
    const events = Array.isArray(entries) ? entries.slice(-20).reverse() : [];
    if (!events.length) {
        container.append(element('div', 'st-empty', 'No engine warnings.'));
        return container;
    }
    for (const entry of events) {
        const row = element('div', `st-diagnostic-event st-${entry.level || 'info'}`);
        const when = Number.isFinite(entry.at) ? new Date(entry.at).toLocaleTimeString() : '';
        row.append(
            element('strong', 'st-diagnostic-code', entry.code || 'ST-STATE'),
            element('span', 'st-diagnostic-message', entry.message || ''),
            element('time', 'st-diagnostic-time', when),
        );
        container.append(row);
    }
    return container;
}

export function renderImportPreview(container, preview, { title = 'Import preview' } = {}) {
    if (!container || typeof document === 'undefined') return null;
    container.replaceChildren();
    container.append(element('h4', '', title));
    if (!preview) return container;
    appendLabelValue(container, 'Changed', preview.changed ? 'yes' : 'no');
    appendLabelValue(container, 'Current digest', preview.currentDigest || 'unknown');
    appendLabelValue(container, 'Imported digest', preview.importedDigest || 'unknown');
    const diff = preview.diff;
    if (diff?.forward) appendLabelValue(container, 'Changed paths', diff.forward.map((item) => item.path).join(', ') || 'None');
    return container;
}

function downloadText(filename, text, type = 'application/json') {
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return false;
    const url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = element('a'); anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
}

/** Mount a small settings drawer and wire backup/restore + read-only dashboard. */
export function renderShadowParity(container, report) {
    if (!container || typeof document === 'undefined') return null;
    container.replaceChildren();
    const value = report ?? {};
    const status = value.status || 'not-run';
    const title = status === 'match' ? 'Parity: match' : status === 'diverged' ? 'Parity: diverged' : 'Parity: not run';
    container.append(element('h4', '', title));
    appendLabelValue(container, 'Supported', (value.supportedRoots ?? ['ct', 'actors', 'scene']).join(', '));
    appendLabelValue(container, 'Matches', Array.isArray(value.matches) ? value.matches.length : 0);
    appendLabelValue(container, 'Divergences', Array.isArray(value.mismatches) ? value.mismatches.length : 0);
    appendLabelValue(container, 'Unsupported', (value.unsupportedDomains ?? value.unsupported ?? []).join(', ') || 'None');
    if (Array.isArray(value.mismatches)) for (const mismatch of value.mismatches.slice(0, 20)) appendLabelValue(container, mismatch.path, `${stringValue(mismatch.expected)} → ${stringValue(mismatch.actual)}`);
    return container;
}

export function mountSettingsUI({ host, store, getMode = () => 'LEGACY', setMode = async () => {}, getDefaultMode = () => 'LEGACY', setDefaultMode = async () => {}, getShadowReport = () => null, getDiagnosticEvents = () => [], onRefresh = () => {}, root = null } = {}) {
    if (typeof document === 'undefined' || !store) return null;
    const parent = root || document.querySelector('#extensions_settings2, #extensions_settings');
    if (!parent) return null;
    const existing = parent.querySelector('#st-state-settings');
    if (existing) return existing;
    const wrapper = element('div', 'st-settings'); wrapper.id = 'st-state-settings';
    const details = element('details', 'inline-drawer');
    details.append(element('summary', 'inline-drawer-header', 'ST-STATE v0.3 evaluator'));
    const content = element('div', 'inline-drawer-content');
    const controls = element('div', 'st-controls');
    const modeLabel = element('label', 'st-mode-label', 'Chat mode');
    const mode = element('select', 'st-mode-select'); mode.setAttribute('aria-label', 'ST-STATE chat mode');
    for (const optionMode of ENGINE_MODES) {
        const option = element('option', '', optionMode);
        option.value = optionMode;
        option.disabled = optionMode === 'NATIVE' && NATIVE_MODE_LOCKED;
        mode.append(option);
    }
    mode.value = getMode();
    modeLabel.append(mode);
    const defaultModeLabel = element('label', 'st-mode-label', 'Default mode');
    const defaultMode = element('select', 'st-mode-select'); defaultMode.setAttribute('aria-label', 'ST-STATE global default mode');
    for (const optionMode of SELECTABLE_MODES) {
        const option = element('option', '', optionMode); option.value = optionMode; defaultMode.append(option);
    }
    defaultMode.value = getDefaultMode();
    defaultModeLabel.append(defaultMode);
    const refresh = element('button', 'menu_button', 'Refresh dashboard');
    const backup = element('button', 'menu_button', 'Download JSON backup');
    const legacy = element('button', 'menu_button', 'Download legacy state');
    const importLatest = element('button', 'menu_button', 'Import latest chat state');
    const file = element('input'); file.type = 'file'; file.accept = '.json,.txt,.html,application/json,text/plain,text/html'; file.setAttribute('aria-label', 'Restore or import ST-STATE data');
    controls.append(defaultModeLabel, modeLabel, refresh, backup, legacy, importLatest, file);
    const diagnostics = element('div', 'st-capability-diagnostics');
    const diagnosticEvents = element('div', 'st-diagnostic-events');
    const parity = element('div', 'st-shadow-parity');
    const preview = element('div', 'st-import-preview'); const dashboard = element('div');
    content.append(controls, element('h4', '', 'Capabilities'), diagnostics, element('h4', '', 'Engine diagnostics'), diagnosticEvents, element('h4', '', 'Shadow parity'), parity, element('h4', '', 'Read-only dashboard'), dashboard, preview);
    details.append(content); wrapper.append(details); parent.append(wrapper);
    const refreshAll = () => {
        try {
            renderDiagnostics(diagnostics, host?.diagnostics?.());
            renderDiagnosticEvents(diagnosticEvents, getDiagnosticEvents());
            renderReadOnlyDashboard(dashboard, store.load());
            renderShadowParity(parity, getShadowReport());
            onRefresh();
        } catch (error) { diagnostics.replaceChildren(element('div', 'st-warning', error.message)); }
    };
    refresh.addEventListener('click', refreshAll);
    mode.addEventListener('change', async () => {
        if (mode.value === 'NATIVE' && NATIVE_MODE_LOCKED) { mode.value = getMode(); return; }
        try { await setMode(mode.value); } catch (error) { mode.value = getMode(); renderImportPreview(preview, { changed: false, currentDigest: 'error', importedDigest: sanitizePlainText(error.message) }, { title: 'Mode change rejected' }); }
        refreshAll();
    });
    defaultMode.addEventListener('change', async () => {
        try { await setDefaultMode(defaultMode.value); }
        catch (error) { defaultMode.value = getDefaultMode(); renderImportPreview(preview, { changed: false, currentDigest: 'error', importedDigest: sanitizePlainText(error.message) }, { title: 'Default mode change rejected' }); }
        refreshAll();
    });
    backup.addEventListener('click', () => downloadText('st-state-backup.json', store.recoveryBackup?.() ?? store.backup()));
    legacy.addEventListener('click', () => downloadText('st-internal-states.html', exportLegacyState(store.load()), 'text/html'));
    importLatest.addEventListener('click', async () => {
        try {
            const chatText = (host?.getChat?.() ?? []).map((message) => message?.mes ?? message?.message ?? message?.content ?? '').join('\n');
            const imported = importLegacyState(chatText, { now: Date.now(), baseState: store.load(), requireComplete: true });
            if (!imported.ok) throw new Error(imported.diagnostics?.join('; ') || 'No complete <internal_states> block was found');
            const current = store.load();
            const backupDocument = {
                extension: 'stState',
                backupVersion: 1,
                kind: 'pre-shadow-baseline',
                exportedAt: Date.now(),
                chatId: host?.getChatId?.() ?? '',
                state: current,
                legacyRaw: imported.block?.wrappedRaw ?? imported.block?.raw ?? '',
            };
            const parsed = { changed: true, current, imported: imported.state, currentDigest: 'current', importedDigest: imported.digest ?? 'legacy', diff: null, legacy: true };
            renderImportPreview(preview, parsed, { title: 'Latest chat baseline preview' });
            if (!globalThis.confirm?.('Import the latest complete <internal_states> block as the Shadow baseline? A recovery file will download first.')) return;
            downloadText('st-state-pre-shadow-backup.json', JSON.stringify(backupDocument, null, 2));
            const report = {
                version: 1,
                status: 'baseline',
                mode: 'SHADOW',
                source: 'manual-latest-chat-import',
                importedAt: Date.now(),
                candidateStatus: 'not_comparable',
                canonical: { source: 'legacy', ct: imported.state.ct, head: imported.state.head, persisted: true },
                recoveryBackup: backupDocument,
            };
            if (typeof store.saveShadowCommit === 'function') await store.saveShadowCommit(imported.state, report, { expectedChatId: host?.getChatId?.() });
            else await store.save(imported.state, { expectedChatId: host?.getChatId?.() });
            refreshAll();
        } catch (error) {
            renderImportPreview(preview, { changed: false, currentDigest: 'error', importedDigest: sanitizePlainText(error.message) }, { title: 'Baseline import rejected' });
        }
    });
    file.addEventListener('change', async () => {
        const selected = file.files?.[0]; if (!selected) return;
        const text = await selected.text();
        try {
            let parsed;
            if (/\.json$/i.test(selected.name)) parsed = store.previewRestore(text);
            else {
                const imported = importLegacyState(text, { now: Date.now() });
                if (!imported.ok) throw new Error(imported.diagnostics?.join('; ') || 'No complete <internal_states> block was found');
                parsed = { changed: true, current: store.load(), imported: imported.state, currentDigest: 'current', importedDigest: 'legacy', diff: null, legacy: true };
            }
            renderImportPreview(preview, parsed);
            if (globalThis.confirm?.('Write this ST-STATE data to the current chat?')) {
                if (parsed.legacy) await store.save(parsed.imported, { expectedChatId: host?.getChatId?.() });
                else await store.restore(text, { expectedChatId: host?.getChatId?.() });
                refreshAll();
            }
        } catch (error) { renderImportPreview(preview, { changed: false, currentDigest: 'error', importedDigest: sanitizePlainText(error.message) }, { title: 'Import rejected' }); }
        file.value = '';
    });
    refreshAll();
    return wrapper;
}

