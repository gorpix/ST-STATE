# ST-STATE v0.4 evaluative architecture

ST-STATE is the state-engine half of ST-ENDGAME's transition to a required bundled extension. This evaluative release observes the existing `<internal_states>` contract before Native mode is unlocked.

## Authority and storage

The canonical state is one JSON document at `SillyTavern.getContext().chatMetadata.stState` for the currently selected chat. Per-chat mode configuration lives at `chatMetadata.stStateConfig`; the latest Shadow parity report is isolated at `chatMetadata.stStateShadow`; the bounded branch ledger and full pre-response checkpoints live at `chatMetadata.stStateBranches`. Global preferences live at `context.extensionSettings.stState` and are persisted through `saveSettingsDebounced()`.

The state document is versioned (`schemaVersion: 2`) and includes the legacy sections (`meta`, `scene`, `actors`, `factions`, `relations`, `residue`, `quests`, `inventory`, `chekhov`, `thoughts`, `notebook`, `lastDnd`, `clocks`, `knowledge`, `commitments`, `artifacts`, `worldSim`, `opaque`, and `history`). Unknown legacy sections and World Sim are retained as opaque raw data. State returned from the store is cloned so dashboard code cannot mutate authority accidentally.

## Transaction lifecycle

1. A generation interceptor selects a small hot pack from the fresh state (exact user mentions, spotlight/on-screen actors, their direct relations, and scene/meta) and injects a protocol plus line-based pack with `setExtensionPrompt`. No chat message is modified for prompt injection.
2. Before each assistant `MESSAGE_RECEIVED`, the extension records the canonical state once for that message slot and selected swipe. The handler then extracts the latest complete `<!--ST_PATCH ... -->` envelope, detects `<flash_handoff .../>`, and derives a swipe-specific identity.
3. Shadow requires a complete, current-format `<internal_states>` block with the expected next turn counter. That legacy import is authoritative. A present ST_PATCH is validated and dry-run against the previous canonical head on a clone; a missing, malformed, stale, or rejected patch makes parity not comparable but does not block a valid legacy import.
4. The parity comparator checks only `ct`, actor paths, and scene paths (mapping `at`/`location` and `doing`/`activity` aliases). Cold domains are listed as unsupported. The imported legacy document is persisted; the dry-run patch and its history never are.
5. For `OOC`, `FLASH`, and flash handoff, both paths are frozen and no state/history/ct change occurs. Missing, incomplete, or out-of-sequence legacy input leaves the canonical document untouched.
6. After persistence or a deliberate reject/ignore decision, the handler removes complete or dangling hidden control payloads from the message display. Model strings are sanitized for plain-text state and dashboard values are inserted with `textContent`.
7. In `SHADOW`, the selected assistant swipe may contain one public `ST_GFX V1` artifact hint. The runtime binds it to the host chat, message slot, and stable swipe identity, caches only the sanitized artifact with that message, strips the hint from the selected swipe, and renders it in a transient local overlay. LEGACY and RECOVERY do not parse or write artifact controls.

## Branch lifecycle

`MESSAGE_SWIPED` fires after SillyTavern loads the selected `swipe_id` and before a newly requested swipe begins generation. ST-STATE atomically restores the slot's full pre-response checkpoint and branch ledger. If the selected swipe already contains a complete state at `checkpoint.ct + 1`, that state becomes authoritative; otherwise the checkpoint remains authoritative for the pending generation or frozen response. `MESSAGE_EDITED`, `MESSAGE_DELETED`, and `MESSAGE_SWIPE_DELETED` invalidate affected ledger entries and rebaseline or roll back without incrementing `ct`. Manual rebaseline, clear, and previous-state restore are explicit and backup-gated in the settings UI.

## Modes

`LEGACY` is the global default and is fully inert. `SHADOW` is the only mode that injects the handshake/hot pack, evaluates ST_PATCH, and processes model-provided ST_GFX hints. `NATIVE` is represented in the protocol model but locked and coerced to `LEGACY` by settings controls. `RECOVERY` is read-only for incoming messages; JSON backup restore is explicit and confirmation-gated. Each atomic Shadow commit stores a pre-import recovery snapshot with its isolated parity report in `stStateShadow`; candidate history never becomes canonical history.

## Local artifact boundary

The model emits structured plain-text arguments, never HTML. `gfx.js` validates an allowlisted `ST_GFX V1` line protocol, caps fields and rows, rejects non-NORMAL or non-public artifacts, and creates a deterministic content identity. `main.js` adds the authoritative chat/slot/swipe binding and keeps a bounded message-local replay cache. `gfx-overlay.js` owns presentation and uses only DOM creation plus `textContent`; it has no state-store authority. Selecting another swipe replaces the overlay branch, while edit/delete/chat-change/recovery actions clear abandoned cards. CSS provides separate iPhone-like and Android-like phone shells and media-specific artifact skins without external assets.

## M2 scope boundary

The implemented reducers are deliberately limited to `actor.set`, `actor.create`, and `scene.set`, with `NORMAL`, `OOC`, and `FLASH` routing. Relationship, agenda, residue, inventory, Chekhov, DND, clocks, knowledge, commitments, persistent artifact state, and full Flash mechanics are represented in the schema/import/export surface but have no M2 mutation reducers. Local artifact rendering is presentation-only and does not widen this mutation boundary.

## Host integration and degradation

`HostAdapter` centralizes released SillyTavern APIs and records feature diagnostics for metadata storage, persistence, prompt injection, message hooks, and generation type. It prefers `setExtensionPrompt` and the documented generation interceptor. If a host capability is missing, the dashboard remains read-only and the extension reports an actionable diagnostic; it never silently falls back to mutating chat history or using staging-only `messageFormatter` hooks.

