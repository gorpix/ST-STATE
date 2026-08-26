# ST-STATE v0.2

Browser-only, third-party [SillyTavern](https://docs.sillytavern.app/for-contributors/writing-extensions/) UI extension for ST-ENDGAME's durable state ledger. It keeps canonical per-chat JSON in `chatMetadata.ff5Engine`, global preferences in `extensionSettings.ff5Engine`, and accepts ordinary assistant prose followed by a hidden `FF5_PATCH` HTML comment. Legacy `ff5Engine` and `FF5_PATCH` identifiers remain for preset/state compatibility.

## Integration roadmap

- ST-STATE will become the required engine shipped with ST-ENDGAME; preset and extension are being developed separately only during the near-term transition.
- ST-FLASH will be absorbed into ST-STATE by **ST-STATE v1.0**.
- ST-STATE and ST-FLASH will be fully integrated into ST-ENDGAME by **ST-ENDGAME v1.0**, leaving one preset distribution with its required extension.

## Scope (Milestones 0–2)

- Release-compatible extension manifest, entry point, settings panel, diagnostics, and read-only dashboard.
- Versioned per-chat schema, migration, backup/restore preview, and tolerant importer/exporter for the current `<internal_states>` legacy format.
- Compact hot-state prompt pack containing `meta`, `scene`, selected actors, and direct relations.
- Strict, atomic M2 patch transactions for `actor.set`, `actor.create`, `scene.set`, and `NORMAL`/`OOC`/`FLASH` routing.
- Commit history with forward/inverse diffs and concise summaries.

Later mechanics (Bonds reducers, agendas, Chekhov, DND, clocks, knowledge, commitments, artifact rendering, and flash orchestration) are intentionally not implemented.

## Install

1. Copy or clone this directory into `data/<user-handle>/extensions/third-party/ST-STATE` (or install it for all users under `public/scripts/extensions/third-party/ST-STATE`).
2. Open SillyTavern's Extensions manager and enable **ST-STATE**.
3. Open the extension drawer to inspect diagnostics and the current chat dashboard.

The entry point is plain browser ES modules; no server plugin and no bundler are required. The manifest uses only released APIs: `SillyTavern.getContext()`, fresh `chatMetadata`, `saveMetadata()`, `extensionSettings`, `saveSettingsDebounced()`, `setExtensionPrompt()`, `MESSAGE_RECEIVED`, `CHAT_CHANGED`, and generation interceptors.

## Protocol

An assistant state-changing turn ends with one hidden comment such as:

```html
<!--FF5_PATCH {"version":2,"base":"h123","mode":"NORMAL","tx":"turn-4","ops":[{"op":"scene.set","set":{"openBeat":"The gate opens"}}]} -->
```

Only the allowlisted M2 operations are accepted. The extension validates the complete transaction before applying anything. `base` must equal the current `head`; a duplicate transaction/message identity is ignored. A successful `NORMAL` commit increments `ct` exactly once and writes a new `head`. `OOC`, `FLASH`, or a response containing `<flash_handoff .../>` never mutates canonical state or history. Missing/invalid patches leave canonical state untouched and produce a non-intrusive diagnostic.

## Development

Requires Node.js 20+ for the test scripts (SillyTavern itself supplies the browser runtime). Run:

```text
npm run verify
```

The tests use Node's built-in test runner and do not require network access or a SillyTavern server. `npm run build` validates the installable manifest and entry-point module graph without creating a runtime bundle.

