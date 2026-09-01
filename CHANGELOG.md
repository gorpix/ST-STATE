# Changelog

## 0.4.2-eval.3

- Added native actor/scene clear operations and a final-beat freshness audit to remove facts that stopped being true.

## 0.4.2-eval.2

- Moved a required Native ST_PATCH tail latch after the local frame so prose cannot silently finish before its transaction.

## 0.4.2-eval.1

- Added native Emotional Residue create, update, clear, remove, local-frame IDs, and Shadow parity.
- Removed Emotional Residue from Native compatibility fragments.

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
