# ST-STATE v0.4.0-eval.5

Browser-only, third-party [SillyTavern](https://docs.sillytavern.app/for-contributors/writing-extensions/) UI extension for ST-ENDGAME's durable state ledger and local in-world artifact renderer. It keeps canonical per-chat JSON in `chatMetadata.stState`, per-chat mode configuration in `chatMetadata.stStateConfig`, shadow parity in `chatMetadata.stStateShadow`, branch checkpoints in `chatMetadata.stStateBranches`, global preferences in `extensionSettings.stState`, and accepts the evaluative `ST_PATCH` and `ST_GFX` hidden line controls.

This release adds opt-in **Hybrid Native** while retaining evaluative Shadow and presentation-only local GFX. `LEGACY` is the default and remains inert. `SHADOW` keeps the imported legacy block authoritative and evaluates its patch on a disposable clone. `NATIVE` makes actor, scene, ct, and numeric relationship patches authoritative; unsupported domains remain locally stored and use a partial compatibility fragment only when they change. `RECOVERY` is read-only for incoming turns.

## Integration roadmap

- ST-STATE will become the required engine shipped with ST-ENDGAME; preset and extension are being developed separately only during the near-term transition.
- ST-FLASH will be absorbed into ST-STATE by **ST-STATE v1.0**.
- ST-STATE and ST-FLASH will be fully integrated into ST-ENDGAME by **ST-ENDGAME v1.0**, leaving one preset distribution with its required extension.
- TODO after the local renderer: persistent in-world phone contacts and offscreen NPC text/call threads powered by FLASH, with unread state and branch-safe conversation history.

## Scope (Evaluative 0.4)

- Release-compatible extension manifest, entry point, settings panel, diagnostics, and read-only dashboard.
- Versioned per-chat schema, migration, backup/restore preview, and tolerant importer/exporter for the current `<internal_states>` legacy format.
- Explicit `LEGACY`, `SHADOW`, `NATIVE`, and `RECOVERY` modes with global default and per-chat override.
- Shadow handshake, compact hot-state pack, strict dry-run patch validation, actor/scene/ct parity diagnostics, and an isolated `stStateShadow` sidecar.
- Active Unified Local Frame projection for Shadow and Hybrid Native prompts. It folds each selected actor's placement, activity, thoughts, and emotional residue into one deterministic record while keeping canonical storage normalized; unmatched material is retained explicitly.
- One injected d20 pre-roll per present NPC. The model must choose the attempted action and lock that actor's DC before consulting the roll; unused rolls expire after the response.
- Per-assistant-slot checkpoints with released SillyTavern swipe/edit/delete event handling. Selecting or generating another swipe restores the common pre-response state before that branch becomes canonical.
- Backup-gated **Rebaseline selected branch**, **Clear current chat state**, and **Restore previous state** controls. Candidate patches never enter canonical history.
- Strict `ST_GFX V1` line parser and local text-only artifact renderer for phone, terminal, paper, map, notice, credential, transaction, web, broadcast, data, image, monitor, and media pop-ins. Phone artifacts include distinct iPhone-like and Android-like chat, notification, call, and email layouts.
- Branch-bound GFX replay cache stored with the selected message swipe; swiping, editing, deleting, clearing, or changing chat replaces or clears abandoned overlays.

Later reducers (factions, residue, quests, inventory, Chekhov, thoughts, notebook, DND, World Sim, clocks, knowledge, commitments, persistent artifact state, phone contact threads, and flash orchestration) are intentionally not implemented. Numeric Bonds/Sparks/Grudge are supported, while directional relationship profiles remain compatibility-backed.

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

The runtime handshake is a multiline `ST_STATE_HANDSHAKE v1` control block ending with `END_ST_STATE_HANDSHAKE`. On a `NORMAL` Shadow turn, every usable legacy block with the expected next `ct` becomes authoritative even when the candidate patch is missing, malformed, stale, or rejected. NPC STATE, BONDS, and SCENE & WORLD remain required prompt output; omitted legacy sections and omitted cold actor/relation/position rows are carried forward from the previous canonical state and reported as `SHADOW_LEGACY_PARTIAL`. Present rows overwrite their matching records, while an explicit `- None` clears the section. Candidate validity affects parity diagnostics only. The `ST_PATCH` candidate is dry-run against the previous head; only actor, scene, and `ct` paths are compared. Other domains are marked unsupported, never failed. `OOC`, `FLASH`, or `<flash_handoff .../>` freeze both paths. A missing block, missing turn header, or out-of-sequence `ct` leaves canonical state untouched and produces diagnostics.

The manual **Import latest chat state** recovery action uses the same bounded compatibility policy for historical blocks. It requires a turn header, shows omitted sections before confirmation, downloads a recovery backup, and carries those domains forward from the current canonical baseline.

Each assistant message slot retains the complete canonical state from immediately before its response. Starting a new swipe restores that checkpoint before generation, so every alternative begins from the same `ct` and head. Selecting an existing completed swipe imports its usable legacy block against that checkpoint. Edit and delete events rebaseline or roll back the affected slot instead of leaving authority on an abandoned branch.

## Hybrid Native protocol

`NATIVE` is opt-in. On NORMAL turns the model emits visible prose plus one authoritative line-based `ST_PATCH`. Actors/NPC state, Scene & World, `ct`, and numeric Bond/Sparks/Grudge update locally and are never repeated as legacy rows. If an unsupported domain changes, the model may emit one partial `<internal_states>` compatibility fragment containing the next Turn header and only the changed unsupported sections; ST-STATE stages that fragment and the patch in one atomic commit, then strips both controls from chat. Unchanged unsupported domains remain in canonical local storage.

Native swipe results retain a bounded post-response diff in the branch ledger. Selecting an existing Native swipe replays that diff from the common pre-response checkpoint; generating a new swipe restores the same checkpoint first.

## Local GFX protocol

On a transactional NORMAL turn that visibly presents an in-world visual medium, ST-ENDGAME emits at most one hidden `ST_GFX V1` line block after state controls. ST-STATE accepts only allowlisted media, public/visible content, bounded plain-text fields, and at most 16 rows. It strips complete, malformed, or dangling controls from the selected swipe and renders accepted artifacts with DOM element creation and `textContent`; model HTML, CSS, scripts, JSON, and external assets are never interpreted.

The settings drawer can enable/disable Shadow pop-ins, choose a minimum duration, and preview every canonical artifact skin in any mode. Dedicated iPhone-like and Android-like buttons remain available for quick phone checks. The renderer extends the local minimum using a bounded visible-message reading-time estimate and caps automatic duration at 45 seconds. A model-supplied `duration` is parsed for transport compatibility but does not override that local timing policy. Parsed artifacts are presentation-only and never enter canonical state or Shadow parity.

The current pack is intentionally text-first: terminal, phone, paper, map, notice, credential, transaction, web, broadcast, data, image, monitor, and media each receive a distinct local CSS shell over the same bounded row schema. It does not yet accept coordinates, remote images, executable controls, audio, QR payloads, or model-authored layout data; those require a separately typed protocol revision.

The iPhone skin will use local SF Pro Display Regular, Medium, and Bold files from `assets/fonts/` when supplied by the user; those proprietary binaries are intentionally not redistributed. Without them it uses the closest system font stack. All status icons are drawn locally by ST-STATE and require no icon font or network request.

## Development

Requires Node.js 20+ for the test scripts (SillyTavern itself supplies the browser runtime). Run:

```text
npm run verify
```

The tests use Node's built-in test runner and do not require network access or a SillyTavern server. `npm run build` validates the installable manifest and entry-point module graph without creating a runtime bundle.

