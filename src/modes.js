/**
 * Runtime mode policy for the evaluative extension.
 *
 * Modes are deliberately kept outside the canonical state document.  The
 * state document is the ledger imported from the preset; mode selection is
 * host configuration and can therefore be changed without creating a state
 * commit.  A chat override lives in `stStateConfig`, while the global default
 * lives in `extensionSettings.stState`.
 */

export const ENGINE_MODES = Object.freeze(['LEGACY', 'SHADOW', 'NATIVE', 'RECOVERY']);
export const SELECTABLE_MODES = Object.freeze(['LEGACY', 'SHADOW', 'RECOVERY']);
export const DEFAULT_ENGINE_MODE = 'LEGACY';
export const SETTINGS_KEY = 'stState';
export const CHAT_CONFIG_KEY = 'stStateConfig';
export const SHADOW_SIDECAR_KEY = 'stStateShadow';
export const NATIVE_MODE_LOCKED = true;

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function isEngineMode(value) {
    return typeof value === 'string' && ENGINE_MODES.includes(value.trim().toUpperCase());
}

/** Normalize untrusted mode input. NATIVE is intentionally coerced away. */
export function normalizeEngineMode(value, { fallback = DEFAULT_ENGINE_MODE } = {}) {
    const candidate = typeof value === 'string' ? value.trim().toUpperCase() : '';
    const safeFallback = SELECTABLE_MODES.includes(String(fallback).trim().toUpperCase())
        ? String(fallback).trim().toUpperCase()
        : DEFAULT_ENGINE_MODE;
    if (!ENGINE_MODES.includes(candidate)) return safeFallback;
    if (candidate === 'NATIVE') return safeFallback;
    return candidate;
}

export function createDefaultSettings() {
    return {
        enabled: true,
        diagnostics: true,
        defaultMode: DEFAULT_ENGINE_MODE,
        nativeLocked: NATIVE_MODE_LOCKED,
    };
}

/** Ensure and return the global settings record without creating aliases. */
export function ensureGlobalSettings(settings) {
    if (!asObject(settings)) return null;
    if (!asObject(settings[SETTINGS_KEY])) settings[SETTINGS_KEY] = createDefaultSettings();
    const record = settings[SETTINGS_KEY];
    if (typeof record.enabled !== 'boolean') record.enabled = true;
    if (typeof record.diagnostics !== 'boolean') record.diagnostics = true;
    record.defaultMode = normalizeEngineMode(record.defaultMode);
    record.nativeLocked = NATIVE_MODE_LOCKED;
    return record;
}

export function getGlobalDefaultMode(settings) {
    const record = asObject(settings)?.[SETTINGS_KEY];
    return normalizeEngineMode(record?.defaultMode);
}

export function setGlobalDefaultMode(settings, mode) {
    const record = ensureGlobalSettings(settings);
    if (!record) throw new Error('Extension settings are unavailable');
    record.defaultMode = normalizeEngineMode(mode);
    return record.defaultMode;
}

export function readChatMode(metadata) {
    const config = asObject(metadata)?.[CHAT_CONFIG_KEY];
    if (!config || !isEngineMode(config.mode)) return null;
    return config.mode.trim().toUpperCase();
}

export function getChatMode(metadata, settings) {
    const requested = readChatMode(metadata);
    if (requested && requested !== 'NATIVE') return requested;
    return requested === 'NATIVE' ? DEFAULT_ENGINE_MODE : getGlobalDefaultMode(settings);
}

export function setChatMode(metadata, mode, { now = Date.now() } = {}) {
    if (!asObject(metadata)) throw new Error('Current chat metadata is unavailable');
    const selected = normalizeEngineMode(mode);
    const previous = asObject(metadata[CHAT_CONFIG_KEY]) ?? {};
    metadata[CHAT_CONFIG_KEY] = {
        ...previous,
        mode: selected,
        nativeLocked: NATIVE_MODE_LOCKED,
        updatedAt: Number.isFinite(now) ? now : Date.now(),
    };
    return selected;
}

export function modeCapabilities(mode) {
    const normalized = normalizeEngineMode(mode);
    return {
        mode: normalized,
        inject: normalized === 'SHADOW',
        process: normalized === 'SHADOW',
        canonicalWrites: normalized === 'SHADOW',
        candidateWrites: false,
        nativeLocked: NATIVE_MODE_LOCKED,
        recoveryWrites: normalized === 'RECOVERY',
    };
}

export function describeMode(mode) {
    const normalized = normalizeEngineMode(mode);
    return {
        mode: normalized,
        label: normalized[0] + normalized.slice(1).toLowerCase(),
        selectable: SELECTABLE_MODES.includes(normalized),
        locked: normalized === 'NATIVE',
    };
}

