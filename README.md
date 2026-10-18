# Warrick Games

Multiplayer browser games for friends at **https://warrick.games**. No accounts: one person creates a game and shares the code or link.

One repo, one Cloudflare Worker per game. Each game is deployed on its own and served under its own path.

| Game | Path | Folder | Status | Dev port |
| --- | --- | --- | --- | --- |
| Hub page | `/` | `hub` | ready | 5170 |
| Crater Club | `/crater-club/` | `games/crater-club` | live | 5173 |
| Light Cycles | `/light-cycles/` | `games/light-cycles` | live | 5174 |
| Curve Ball | `/curve-ball/` | `games/curve-ball` | live | 5175 |
| Ricochet Alley | `/ricochet-alley/` | `games/ricochet-alley` | live | 5176 |
| Boom Room | `/boom-room/` | `games/boom-room` | live | 5177 |
| Turf War | `/turf-war/` | `games/turf-war` | live | 5178 |
| Pill Panic | `/pill-panic/` | `games/pill-panic` | live | 5179 |
| Stack Attack | `/stack-attack/` | `games/stack-attack` | live | 5180 |
| Dice Dominion | `/dice-dominion/` | `games/dice-dominion` | not deployed | 5181 |

The dev ports are the ones in `.claude/launch.json`, so every game can run at the same time.

## Layout

```
hub/            the page at warrick.games/: static files on the Custom Domain warrick.games
games/<name>/   one game: Vite client, Worker, one Durable Object per room, on the route warrick.games/<name>*
packages/kit/   what the games share: rooms, the lobby, networking, the page shell, base styles, build config
```

This is an npm workspace. The shared tooling (Vite, the Cloudflare Vite plugin, wrangler, Vitest, TypeScript) is in the root `package.json`, with one `package-lock.json`.

The games' shared code lives in `packages/kit` (`@warrick/kit`; see its README): the Durable Object base, the lobby rules, the Worker router, the reconnecting socket, the home/lobby/chat shell, the sound core, the base stylesheet and the Vite and TypeScript config. Each game keeps only its own rules, screen and look. Every game is built on it.

## Commands

```bash
npm install                            # once, at the root
npm run dev -w games/crater-club       # one game (or `npm run dev` inside its folder)
npm test                               # every workspace, the kit included
npm run typecheck
npm run deploy -w games/crater-club    # deploy one game
npm run deploy -w hub
```

## How the routing works

- The hub's Worker has `warrick.games` as a Custom Domain. Cloudflare creates the apex DNS record and certificate for it on deploy, which is also what lets the game routes run: routes only work on a hostname with a proxied DNS record.
- Each game's Worker has a zone route on the same hostname, like `warrick.games/crater-club*`. Routes take precedence over a Custom Domain, so each game gets its own paths.
- Anything no game claims goes to the hub. Paths that don't match a file get `hub/public/404.html` with a 404 status. That includes games that aren't deployed yet.

## Adding a game

1. Create `games/<name>/` and give it a free port in `.claude/launch.json`. Start from a game like it: Stack Attack or Turf War (real-time), Crater Club (turn-based), or Light Cycles (real-time rounds with timers between them).
2. Build it on `@warrick/kit` (see its README): `vite.config.ts` is `gameConfig("<name>")`, which sets Vite's `base` to `/<name>/` and nests the built client under `dist/client/<name>/` (Workers static assets are looked up by request path and ignore Vite's `base`); the Worker is `gameWorker("<name>")`, with its API under `/<name>/api/...`; the client's `Shell` builds every URL from `import.meta.env.BASE_URL`.
3. Give its `wrangler.jsonc` the route `{ "pattern": "warrick.games/<name>*", "zone_name": "warrick.games" }`, `workers_dev: false` and `run_worker_first: ["/<name>/api/*"]`.
4. Pick its `localStorage` prefix (`cc`, `lc`, …) and pass it to the `Shell`: every game shares the warrick.games origin.
5. Deploy the game, then turn its card in `hub/public/index.html` from "Coming soon" into a link and deploy the hub.
