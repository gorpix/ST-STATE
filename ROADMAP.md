# ST-STATE 1.0 roadmap

1.0 means NATIVE is the recommended way to play ST-ENDGAME, it holds up over long chats, and the full legacy state block plays no part in normal play. This plan covers ST-STATE and the ST-ENDGAME preset together.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Default mode | NATIVE for new chats when ST-ENDGAME is detected; LEGACY otherwise. The 1.0 preset drops the Adult Mode prompt. |
| 2 | Required native domains | Relationship profiles, Chekhov's Gun, inventory and skills, GM notebook. Quests, factions, and the DND log follow in 1.1. |
| 3 | State Engine in NATIVE | Split the preset's State Engine into **State Rules** (always on) and **Legacy State Output** (template and append rule; LEGACY and SHADOW only). ST-STATE never edits the prompt; it reads the final prompt on `CHAT_COMPLETION_PROMPT_READY` and warns when Legacy State Output is on in NATIVE or off in LEGACY. The same read-only check detects ST-ENDGAME for decision 1. |
| 4 | SHADOW | Kept as a diagnostic mode, no longer recommended for play. |

## Phase 1: Reliability baseline

| Task | Size | Done when |
|---|---|---|
| ✅ Chekhov parser reads groups on their own lines and pipe-separated entries | S | A test with the three-line form models write passes |
| Same tolerance for inventory, quests, and profiles split across lines | S | Each has a test with real model layouts |
| Dashboard reliability counter per chat: committed / malformed / rejected / missing | S | The success rate is visible without reading chat files |
| Live SillyTavern checklist: streaming on and off, swipes, edits, deletes, chat switching, OOC, FLASH, GFX | M | Every item passes; each bug found gets a fix and a test |
| One or two NATIVE chats of 50+ turns on the current version | M | At least 95% of turns commit and no state is lost |

## Phase 2: Native domains

Each domain gets an item-level schema, patch operations, validation, a reducer, a local-frame projection (only when the domain has data), protocol lines (only when the domain is in play), legacy import and export, Shadow parity, and tests.

| Domain | Example operations | Size | Release |
|---|---|---|---|
| Relationship profiles | `relation.profile\|A\|B\|trust\|Reliable` | S-M | 1.0 |
| Chekhov's Gun | `chekhov.add\|C1\|text\|weight`, `chekhov.lock\|C1`, `chekhov.fire\|C1` | M | 1.0 |
| Inventory and skills (PC only) | `inv.add\|item`, `inv.remove\|item`, `skill.add\|title`, `status.set\|text`, `mods.set\|text` | M | 1.0 |
| GM notebook | `note.add\|T\|text`, `note.remove\|N3` (cap 20) | S | 1.0 |
| Quests, factions | `quest.set\|Q1\|state\|active`, `faction.set\|Name\|goal\|text` | M | 1.1 |
| DND task log | `dnd.set\|field\|value` | S | 1.1 |

Schema v3 migration: split the single-string inventory and Chekhov lists into item records with IDs, and upgrade existing chats on load.

Out of scope for 1.0: World Sim, clocks, knowledge, commitments, artifacts, and full FLASH mechanics. They stay stored as they are, and anything not yet native keeps the partial compatibility block as a fallback.

## Phase 3: Preset alignment

| Task | Size |
|---|---|
| Split the State Engine into State Rules and Legacy State Output (decision 3) | M |
| ST-STATE read-only prompt check and mismatch warning | S |
| Partial-block row formats for 1.1 domains carried in the NATIVE protocol, so they do not need Legacy State Output | S |
| NATIVE protocol size budget (about 1,500 tokens) enforced by a test | S |
| Remove Adult Mode from the preset | S |
| Align BOLT and State Rules wording with the final operations | S |

## Phase 4: Release

| Task | Size |
|---|---|
| Merge `protocol-slim` into `main` (ST-STATE) and `v0.5-slim` into `main` (ST-ENDGAME) | S |
| Version 1.0.0 in the manifest and asset cache-bust queries; remove "eval" and "v0.4 evaluator" labels | S |
| NATIVE as the default with ST-ENDGAME (decision 1) | S |
| Rewrite README and ARCHITECTURE; upgrade notes for existing chats | S |
| Tag a GitHub release | S |
