# ST-STATE v0.2 architecture

ST-STATE is the state-engine half of ST-ENDGAME's transition to a required bundled extension. ST-FLASH joins ST-STATE by ST-STATE v1.0; both become integrated ST-ENDGAME components by ST-ENDGAME v1.0. Compatibility-sensitive `ff5Engine` storage and `FF5_PATCH` protocol names remain stable during that transition.

## Authority and storage

The canonical state is one JSON document at `SillyTavern.getContext().chatMetadata.ff5Engine` for the currently selected chat. The extension never keeps a `chatMetadata` object in a long-lived field: every read and write obtains the current context again. Global preferences live at `context.extensionSettings.ff5Engine` and are persisted through `saveSettingsDebounced()`.

The state document is versioned (`schemaVersion: 2`) and includes the legacy sections (`meta`, `scene`, `actors`, `factions`, `relations`, `residue`, `quests`, `inventory`, `chekhov`, `thoughts`, `notebook`, `lastDnd`, `clocks`, `knowledge`, `commitments`, `artifacts`, `worldSim`, `opaque`, and `history`). Unknown legacy sections and World Sim are retained as opaque raw data. State returned from the store is cloned so dashboard code cannot mutate authority accidentally.

## Transaction lifecycle

1. A generation interceptor selects a small hot pack from the fresh state (exact user mentions, spotlight/on-screen actors, their direct relations, and scene/meta) and injects a protocol plus line-based pack with `setExtensionPrompt`. No chat message is modified for prompt injection.
2. `MESSAGE_RECEIVED` runs before normal rendering. The handler extracts the latest complete `<!--FF5_PATCH ... -->` envelope, detects `<flash_handoff .../>`, and derives a stable message identity.
3. The validator rejects unknown envelope keys, operations, fields, paths, IDs, types, lengths, and ranges. The whole transaction is validated before any reducer runs.
4. For `NORMAL`, the store checks the base head and dedupe set, applies all M2 operations to a clone, increments `ct` once, creates a new head, and computes forward/inverse diffs. Metadata is written atomically; failed persistence rolls the metadata reference back.
5. For `OOC`, `FLASH`, and flash handoff, the staged patch is discarded and no state/history/ct change occurs. A missing or invalid `NORMAL` patch similarly leaves the canonical document untouched.
6. Only after persistence (or a deliberate reject/ignore decision) does the handler remove a well-formed hidden control comment from the message display. If parsing fails, prose remains unchanged except for removal of that hidden comment. Model strings are sanitized for plain-text state and dashboard values are inserted with `textContent`.

## M2 scope boundary

The implemented reducers are deliberately limited to `actor.set`, `actor.create`, and `scene.set`, with `NORMAL`, `OOC`, and `FLASH` routing. Relationship, agenda, residue, inventory, Chekhov, DND, clocks, knowledge, commitments, artifact, and full Flash mechanics are represented in the schema/import/export surface but have no M2 mutation reducers. This keeps cold state intact while making the transaction boundary testable.

## Host integration and degradation

`HostAdapter` centralizes released SillyTavern APIs and records feature diagnostics for metadata storage, persistence, prompt injection, message hooks, and generation type. It prefers `setExtensionPrompt` and the documented generation interceptor. If a host capability is missing, the dashboard remains read-only and the extension reports an actionable diagnostic; it never silently falls back to mutating chat history or using staging-only `messageFormatter` hooks.

