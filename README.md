# ST-STATE v0.3.0-eval.2

Browser-only, third-party [SillyTavern](https://docs.sillytavern.app/for-contributors/writing-extensions/) UI extension for ST-ENDGAME's durable state ledger. It keeps canonical per-chat JSON in `chatMetadata.stState`, per-chat mode configuration in `chatMetadata.stStateConfig`, shadow parity in `chatMetadata.stStateShadow`, branch checkpoints in `chatMetadata.stStateBranches`, global preferences in `extensionSettings.stState`, and accepts the evaluative `ST_PATCH` hidden comment.

This release is an evaluative Shadow build. `LEGACY` is the default and performs no injection or message processing. `SHADOW` asks the model for both a complete `<internal_states>` block and an `ST_PATCH`; the imported legacy block remains authoritative while the patch is applied only to a disposable clone. `NATIVE` is present in the mode model but locked, and `RECOVERY` is read-only for incoming turns.

## Integration roadmap

- ST-STATE will become the required engine shipped with ST-ENDGAME; preset and extension are being developed separately only during the near-term transition.
- ST-FLASH will be absorbed into ST-STATE by **ST-STATE v1.0**.
- ST-STATE and ST-FLASH will be fully integrated into ST-ENDGAME by **ST-ENDGAME v1.0**, leaving one preset distribution with its required extension.

## Scope (Evaluative 0.3)

- Release-compatible extension manifest, entry point, settings panel, diagnostics, and read-only dashboard.
- Versioned per-chat schema, migration, backup/restore preview, and tolerant importer/exporter for the current `<internal_states>` legacy format.
- Explicit `LEGACY`, `SHADOW`, `NATIVE`, and `RECOVERY` modes with global default and per-chat override.
- Shadow handshake, compact hot-state pack, strict dry-run patch validation, actor/scene/ct parity diagnostics, and an isolated `stStateShadow` sidecar.
- Per-assistant-slot checkpoints with released SillyTavern swipe/edit/delete event handling. Selecting or generating another swipe restores the common pre-response state before that branch becomes canonical.
- Backup-gated **Rebaseline selected branch**, **Clear current chat state**, and **Restore previous state** controls. Candidate patches never enter canonical history.

Later mechanics (Bonds reducers, agendas, Chekhov, DND, clocks, knowledge, commitments, artifact rendering, and flash orchestration) are intentionally not implemented.

## Install

1. Copy or clone this directory into `data/<user-handle>/extensions/ST-STATE` (or install it for all users under `public/scripts/extensions/third-party/ST-STATE`).
2. Open SillyTavern's Extensions manager and enable **ST-STATE**.
3. Open the extension drawer to inspect diagnostics and the current chat dashboard.

The entry point is plain browser ES modules; no server plugin and no bundler are required. The manifest uses only released APIs: `SillyTavern.getContext()`, fresh `chatMetadata`, `saveMetadata()`, `extensionSettings`, `saveSettingsDebounced()`, `setExtensionPrompt()`, `MESSAGE_RECEIVED`, `MESSAGE_SWIPED`, `MESSAGE_EDITED`, `MESSAGE_DELETED`, `MESSAGE_SWIPE_DELETED`, `CHAT_CHANGED`, and generation interceptors.

## Shadow protocol

In `SHADOW`, an assistant turn includes a complete `<internal_states>` block and one hidden line patch such as:

```text
<!--ST_PATCH
V2
base=h123
mode=NORMAL
tx=turn-4
scene.set|openBeat|The gate opens
-->
```

The runtime handshake is a multiline `ST_STATE_HANDSHAKE v1` control block ending with `END_ST_STATE_HANDSHAKE`. On a `NORMAL` Shadow turn, every complete legacy block with the expected next `ct` becomes authoritative even when the candidate patch is missing, malformed, stale, or rejected. Candidate validity affects parity diagnostics only. The `ST_PATCH` candidate is dry-run against the previous head; only actor, scene, and `ct` paths are compared. Other domains are marked unsupported, never failed. `OOC`, `FLASH`, or `<flash_handoff .../>` freeze both paths. A missing legacy block or out-of-sequence `ct` leaves canonical state untouched and produces diagnostics.

Each assistant message slot retains the complete state from immediately before its response. Starting a new swipe restores that checkpoint before generation, so every alternative begins from the same `ct` and head. Selecting an existing completed swipe imports its complete legacy block from that checkpoint. Edit and delete events rebaseline or roll back the affected slot instead of leaving authority on an abandoned branch.

## Development

Requires Node.js 20+ for the test scripts (SillyTavern itself supplies the browser runtime). Run:

```text
npm run verify
```

The tests use Node's built-in test runner and do not require network access or a SillyTavern server. `npm run build` validates the installable manifest and entry-point module graph without creating a runtime bundle.

