# Changelog

## Unreleased

- Slimmed the injected SHADOW and NATIVE protocols (v2): one shared rule set, outcome-based wording instead of the scripted freshness audit, and no rules the preset already owns (header text, routing).
- Made OOC and FLASH consistent across modes: OOC ends with an empty `mode=OOC` envelope; FLASH ends with its `<flash_handoff/>`.
- Injected the `ST_GFX V1` rules in SHADOW and NATIVE while local GFX is enabled, so the preset's Pop-In Graphics prompt is no longer needed.

## 0.4.4-eval.3

- Accepted legacy-shaped `actor.set|ID|once|field|value` and `hold` lifetime modifiers without discarding sibling actor updates.

## 0.4.4-eval.2

- Expired unrefreshed present-actor and scene happenings without aging durable knowledge or relationships.
- Added `actor.hold` for continuing conditions and `actor.once` for one-response actions.
- Recovered missing Native tails as zero-delta commits for header-bearing NORMAL responses, including regenerated swipes.

## 0.4.3

- Added native Emotional Residue updates, derived local-frame IDs, and Shadow parity.
- Added reliable patch-tail enforcement plus semantic actor/scene clearing.
- Included positioned participants in freshness checks and replaced stale location/activity aliases atomically.

## 0.4.1

- Stopped Native compatibility diffs from recursively embedding canonical history.
- Automatically compacted already-expanded history records during state migration.

## 0.4.0-eval.15

- Pruned oldest branch checkpoints automatically when the ledger reaches its storage cap.
- Accepted object-shaped and mixed-delimiter legacy VAD, clamped numeric ranges, and ignored unusable VAD without rejecting other valid changes.

## 0.4.0-eval.14

- Accepted advisory legacy `ct` patch lines and routed actor `thoughts` into canonical Native state.

## 0.4.0-eval.13

- Kept the quick dashboard in a single-column layout at every screen width.

## 0.4.0-eval.12

- Fixed the quick dashboard panel opener and verified the live launcher end to end.

## 0.4.0-eval.11

- Bound the dashboard button to the same persistent launcher lifecycle as the phone.
- Added versioned browser assets so extension updates cannot retain stale modules or styles.

## 0.4.0-eval.10

- Made the dashboard launcher mount independently of the settings drawer.

## 0.4.0-eval.9

- Added an always-available read-only dashboard launcher beside the phone button.

## 0.4.0-eval.8

- Accepted idempotent first-turn actor creation and legacy full-name fields.
- Exposed Native validator errors directly in Engine diagnostics.

## 0.4.0-eval.7

- Added automatic first-turn Native identity bootstrap.
- Added guaranteed bootstrap NPC dice pools and header-first patch controls.
- Preserved Shadow parity, branch recovery, and local GFX boundaries.

## 0.4.0-eval.4–.6

- Added opt-in Hybrid Native reducers, sparse compatibility fragments, local-frame routing, and present-NPC d20 pre-rolls.
