import {
    initialize,
    ff5EngineGenerateInterceptor,
    getRuntime,
    onActivate,
    onInstall,
    onUpdate,
    onEnable,
    onDisable,
} from './src/main.js';

// SillyTavern resolves `generate_interceptor` by global name. Set it before
// initialization so generation can use the release interceptor route even when
// the extension loader calls the hook very early.
globalThis.ff5EngineGenerateInterceptor = ff5EngineGenerateInterceptor;

if (globalThis.SillyTavern?.getContext) {
    try { initialize(); } catch (error) { console.warn('[FF5] Initialization deferred:', error); }
}

export { initialize, ff5EngineGenerateInterceptor, getRuntime, onActivate, onInstall, onUpdate, onEnable, onDisable };
export * from './src/index.js';

