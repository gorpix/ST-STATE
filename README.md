# ST-STATE v0.4.0-eval.12

Browser-only SillyTavern extension for per-chat state, Shadow parity, evaluative Hybrid Native updates, branch-safe swipes, and local Pop-In GFX.

## Scope

- `LEGACY` — inert; the preset owns the complete `<internal_states>` ledger.
- `SHADOW` — imports the legacy ledger as authority and dry-runs `ST_PATCH` for parity.
- `NATIVE` — commits validated actor, scene, turn, and numeric Bond/Sparks/Grudge updates locally.
- `RECOVERY` — read-only incoming-turn mode.

Native is opt-in and evaluative. Actors, actor thoughts, scene, and numeric relationships are native. Factions, residue, quests, inventory, Chekhov, notebook, DND, World Sim, clocks, knowledge, commitments, and persistent artifact state remain compatibility-backed.

The extension also provides a unified local frame, automatic first-turn identity bootstrap, one injected d20 per present NPC, branch checkpoints for swipes/edits/deletes, and a text-only `ST_GFX V1` renderer. Bootstrap adds identity records only; scene and mechanics changes require a validated transaction.

## Install

1. Open SillyTavern's extensions panel and choose **Install extension**.
2. Enter `https://github.com/gorpix/ST-STATE`, install it, and enable the extension.
3. Select a per-chat mode in the extension drawer.

The extension uses browser ES modules and released SillyTavern APIs. No server plugin or bundler is required.

## Development

Requires Node.js 20+.

```text
npm run verify
```

## License

MIT. See [LICENSE](LICENSE).
