# Warrick Games

Multiplayer browser games for friends at **https://warrick.games**. No accounts: one person creates a game and shares the code or link.

One repo, one Cloudflare Worker per game. Each game is deployed on its own and served under its own path.

| Game | Path | Folder | Status | Dev port |
| --- | --- | --- | --- | --- |
| Hub page | `/` | `hub` | ready | 5170 |
| Crater Club | `/crater-club/` | `games/crater-club` | live | 5173 |
| Light Cycles | `/light-cycles/` | `games/light-cycles` | in progress | 5174 |
| Curve Ball | `/curve-ball/` | `games/curve-ball` | in progress | 5175 |
| Ricochet Alley | `/ricochet-alley/` | `games/ricochet-alley` | in progress | 5176 |
| Boom Room | `/boom-room/` | `games/boom-room` | in progress | 5177 |
| Turf War | `/turf-war/` | `games/turf-war` | in progress | 5178 |

The dev ports are the ones in `.claude/launch.json`, so every game can run at the same time.

## Layout

```
hub/            the page at warrick.games/: static files on the route warrick.games/*
games/<name>/   one game: Vite client, Worker, one Durable Object per room, on the route warrick.games/<name>*
```

This is an npm workspace. The shared tooling (Vite, the Cloudflare Vite plugin, wrangler, Vitest, TypeScript) is in the root `package.json`, with one `package-lock.json`. The games don't share code yet; each has its own copy of the room, lobby and networking code it took from Crater Club.

## Commands

```bash
npm install                            # once, at the root
npm run dev -w games/crater-club       # one game (or `npm run dev` inside its folder)
npm test                               # every workspace
npm run typecheck
npm run deploy -w games/crater-club    # deploy one game
npm run deploy -w hub
```

## How the routing works

- The hub's Worker has the zone route `warrick.games/*`.
- Each game's Worker has a route like `warrick.games/crater-club*`. When several routes match a request, Cloudflare uses the most specific one, so a game's route beats the hub's catch-all.
- Anything no game claims goes to the hub. Paths that don't match a file get `hub/public/404.html` with a 404 status. That includes games that aren't deployed yet.

Routes only run on hostnames that have a proxied (orange-cloud) DNS record. The `warrick.games` apex needs one before any of this works. Cloudflare's placeholder for a hostname served only by Workers is `AAAA @ 100::`, proxied.

## Adding a game

1. Create `games/<name>/` and give it a free port in `.claude/launch.json`.
2. Serve it under its path: Vite `base: "/<name>/"`, the client's fetch and WebSocket URLs built from `import.meta.env.BASE_URL`, the Worker's API under `/<name>/api/...`, and `run_worker_first: ["/<name>/api/*"]`.
3. Nest its built client under `dist/client/<name>/`. Workers static assets are looked up by request path and ignore Vite's `base`. Crater Club's `vite.config.ts` has a small plugin that does this; copy it.
4. Give its `wrangler.jsonc` the route `{ "pattern": "warrick.games/<name>*", "zone_name": "warrick.games" }` and set `workers_dev: false`.
5. Prefix its `localStorage` keys (`cc.`, `lc.`, …): every game shares the warrick.games origin.
6. Deploy the game, then turn its card in `hub/public/index.html` from "Coming soon" into a link and deploy the hub.
