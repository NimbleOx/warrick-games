# Hub

The page at **https://warrick.games/**: a list of the games, each linking to its own path. It's static files in `public/`, deployed as a Cloudflare Worker with no script on the Custom Domain `warrick.games`. The [root README](../README.md) explains how the game routes take precedence over it.

```bash
npm run dev -w hub      # http://localhost:8787 (the root .claude/launch.json uses 5170)
npm run deploy -w hub   # wrangler deploy
```

- Keep the hub's own files at paths no game will use (`/style.css`, `/favicon.svg`, `/icons/`).
- Unknown paths get `public/404.html`.
- When a game goes live, give its card in `public/index.html` the title link (`<a class="game-link" href="/<name>/">`), which covers the whole card. A game with solo play also gets a Solo button beside Play (`<a class="tag tag-solo" href="/<name>/solo">`), which starts a solo game straight away (see the kit's README).
- Before attaching a custom domain, check DNS against the zone's authoritative nameservers (`dig @mina.ns.cloudflare.com <name>`), not the local resolver, which caches the "doesn't exist" answer for 30 minutes.

## Icons

Each game has a 32×32 SVG in `public/icons/<name>.svg`. They're one set, so a new icon follows the same rules:

- The tile is `<rect width="32" height="32" rx="6">` filled with its hue's **tile** tone. Every hue's colors have the same chroma (OKLCH), so no icon is louder than the others.
- One hue leads the icon and its tile. Use one more hue at most, plus the neutrals. Pick a lead hue its neighbours on the page don't use.
- Keep the artwork inside 3–29. Ground or grid lines that run off the edge are clipped to the tile (`<clipPath id="tile">`).
- Flat fills, main strokes 2–2.5 wide, details 1.5. No opacity, gradients or `<text>`: draw glyphs as paths.

| Hue | tile | dk | lo | base | hi | Used by |
| --- | --- | --- | --- | --- | --- | --- |
| red | `#29100d` | `#4f2420` | `#9d352f` | `#ed6257` | `#f5b5ad` | Boom Room, Box Office |
| orange | `#271204` | `#4c290e` | `#b05a03` | `#ff8c2b` | `#ffd9c1` | Crater Club, Pocket Wars |
| amber | `#221601` | `#432f01` | `#ad7e01` | `#f7b503` | `#ffeccc` | Double Trouble |
| lime | `#131c06` | `#293911` | `#608718` | `#91c639` | `#d7f0ba` | Corner Shop, Base Jump |
| green | `#081e0e` | `#163c20` | `#1d8843` | `#43c96d` | `#bcedc5` | Turf War |
| teal | `#011e1a` | `#033c36` | `#04877c` | `#0cc8b9` | `#a8f2e8` | Dice Dominion |
| cyan | `#001d21` | `#013a42` | `#038797` | `#04c7df` | `#adf2ff` | Light Cycles |
| blue | `#0a192b` | `#1a3453` | `#2366b4` | `#53a0ff` | `#b3d4fe` | Liar's Dice |
| indigo | `#14162b` | `#2b2f53` | `#585db7` | `#8c95ff` | `#cad1fe` | Ricochet Alley |
| violet | `#1c1328` | `#392a4e` | `#7c54ae` | `#ba86fe` | `#e0cdfe` | Stack Attack |
| magenta | `#241020` | `#472540` | `#a14d92` | `#ec7bd6` | `#feccf2` | Dust Up |
| rose | `#280f15` | `#4e232c` | `#a83f59` | `#f96b8d` | `#ffc1cb` | Pill Panic |

Neutrals: ink `#0b0d17` (pips, eyes), `#20263f`, `#3a4370`, `#8d94b8`, paper `#eef0fa` (dice, dots).
