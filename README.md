# ST-STATE

ST-STATE is a SillyTavern companion extension for its related preset ST-ENDGAME, a persistent state tracker developed with maximum output token savings in mind compared to its inspiration, Freaky Frankenstein 5's Internal States.

## Features

- Unified FF5.2-style state tracker - entire scene is now under 'Actors & Scene', relationship mechanics expanded
  - Evaluative 'Emotional Residue' state added - tracks events impactful to NPCs
- Massive output token savings (currently 80+%, 50+% total response) and turn latency decrease
  - For now, only Actors & Scene, Emotional Residue and Relationships are handled natively, while the rest are FF5.2-compatible
- Input token savings from injecting states only relevant to the scene
- Structured output with defined transactions instead of freeform text
- Locally generated Android and iPhone - I think they actually look pretty nice - actual texting mechanics are a proven-possible endgoal (see ST-FLASH)
  - Persistent floating button so you can whip out your 17 Pro Max whenever you feel like it
  - Many other graphics such as maps and business cards that in their present state are still basic HTML
- Local d20 generated and sent for {{user}} and present NPCs


![iPhone](https://github.com/gorpix/ST-STATE/blob/main/iphone.PNG?raw=true)
![Android](https://github.com/gorpix/ST-STATE/blob/main/android.PNG?raw=true)

## To-do

- Automatic NPC Character Card generation and periodic tracking (cache-friendly)
- Eventual supersession of ST-ENDGAME and ST-FLASH with all features consolidated
- Complete state conversion to native format for 90+% output token savings compared to FF5.2 IS
- Rework most pop-in graphics

## Modes

- `LEGACY` — inert; the preset owns the complete `<internal_states>` ledger.
- `SHADOW` — imports the legacy ledger as authority and dry-runs `ST_PATCH` for parity.
- `NATIVE` — commits validated actor, scene, residue, turn, and numeric Bond/Sparks/Grudge updates locally.
- `RECOVERY` — read-only incoming-turn mode.

Native is opt-in and evaluative. Actors, actor thoughts, scene, Emotional Residue, and numeric relationships are native.
Everything else remains compatibility-backed.

## Installgemne

1. Download and install ST-ENDGAME https://github.com/gorpix/ST-ENDGAME
2. Open SillyTavern's extensions panel and choose **Install extension**.
3. Enter `https://github.com/gorpix/ST-STATE`, install it, and enable the extension.
4. Select a per-chat mode in the extension drawer.

The extension uses browser ES modules and released SillyTavern APIs. No server plugin or bundler is required.

## Development

Requires Node.js 20+.

```text
npm run verify
```

## License

MIT. See [LICENSE](LICENSE).
