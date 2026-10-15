# Ricochet Alley

A top-down tank battle in a maze, in the spirit of Atari *Combat* and *Tank Trouble*. Tanks drive and rotate; bullets bounce off walls and expire after a few seconds. One hit kills — including your own bullet coming back around. Last tank standing wins the round.

## Rules for v1

- 2–8 players online, each on their own device. ↑/↓ drive, ←/→ rotate, Space fires. On touch screens: a virtual stick and a fire button.
- A new random maze every round: a grid maze with some extra walls knocked out so it has loops.
- Each tank can have up to 5 bullets in flight. Bullets live about 6 seconds and reflect off walls.
- Scoring: 1 point for being the last tank alive in a round. First to the target score (host picks; default 10) wins.
- CPU players: path toward the nearest enemy over the maze grid (BFS), and fire when a ray with up to 2 bounces would hit an enemy.
- Not in v1: power-ups (laser, shotgun, homing missile, mines) and team mode. Design so they can be added.

## Design notes

- Walls are axis-aligned segments on a grid, which keeps collisions simple: tanks are circles against segments, bullets are points that reflect off them.
- Free movement needs smoothing: clients predict their own tank and interpolate others between server updates. The server decides every hit.

## How to build it

Copy the architecture of Crater Club, the turn-based artillery game in `../crater-club`. Read its README first. Sibling projects `../light-cycles` and `../boom-room` are being built the same way by other sessions — read them for ideas if useful, but don't modify them.

- Cloudflare Worker + Vite (`@cloudflare/vite-plugin`), TypeScript, no client framework, canvas rendering.
- One Durable Object per 5-character room code. `POST /api/games` creates a room, `/g/CODE` is the invite link, `/api/games/CODE/ws` is the WebSocket.
- No accounts: a random token in `localStorage` maps to a player slot, so a reload puts you back in your seat.
- Lobby: the host picks settings, can add CPU players, and starts the match. Up to 8 players.
- Reuse and adapt from Crater Club: `src/client/net.ts` (reconnecting socket), `src/worker/index.ts` (routing, code allocation), `src/worker/room.ts` (Durable Object, sockets, persistence, alarm), the lobby markup and styles in `index.html` and `src/client/style.css`, and the Vite / wrangler / tsconfig / Vitest setup.

### Real-time, unlike Crater Club

Crater Club is turn-based. This game is real-time:

- During a round, the Durable Object runs the authoritative simulation on a fixed tick (start at 30 Hz) with `setInterval`. Stop the loop between rounds so the object can hibernate.
- Clients send only input changes. The server broadcasts compact updates; clients render smoothly between them and may predict their own movement.
- Keep the simulation in `src/shared/` as pure functions, so Vitest can test it and clients can run it for prediction.
- Persist room state at round boundaries, not every tick.

## Lessons from Crater Club

- Deploying restarts every Durable Object and drops every socket. Clients must reconnect and resync from a full snapshot.
- When a button has keyboard focus, let it own Space/Enter; don't also fire game hotkeys.
- Make every limit visible. If something stops a player from acting, the UI must say why.
- Before attaching a custom domain, check DNS against the zone's authoritative nameservers (`dig @mina.ns.cloudflare.com <name>`), not the local resolver, which caches the "doesn't exist" answer for 30 minutes.

## Deploying

Cloudflare, same account as Crater Club. The game is served at `https://warrick.games/ricochet-alley/`: a path on one shared site, not a subdomain. The hub page at the root is its own Worker in `../../hub`, with `warrick.games` as a Custom Domain. This game gets its own Worker with a zone route on the same hostname, and routes take precedence over a Custom Domain. Each game is its own folder under `games/` in this repo and its own Worker, and deploys on its own. Crater Club already works this way; copy its setup.

- `wrangler.jsonc`: `"routes": [{ "pattern": "warrick.games/ricochet-alley*", "zone_name": "warrick.games" }]` (a zone route, not a custom domain), `workers_dev: false`, `preview_urls: false`, and `run_worker_first: ["/ricochet-alley/api/*"]`.
- Vite `base: "/ricochet-alley/"`. Build every client URL from `import.meta.env.BASE_URL`: fetches, the WebSocket, invite links (`/ricochet-alley/g/CODE`) and the router's `history` paths. The Worker's API lives under `/ricochet-alley/api/...`. Locally the game is at `http://localhost:<port>/ricochet-alley/`.
- Static assets gotcha: Workers static assets are looked up by request path and ignore Vite's `base`. Vite writes `dist/client/assets/...`, but the page asks for `/ricochet-alley/assets/...`, so every asset 404s in production while `npm run dev` looks fine. Copy the `nestClientUnderBase` plugin from Crater Club's `vite.config.ts`. It moves the client build into `dist/client/ricochet-alley/` and leaves `index.html` at the root, because the single-page-application fallback always serves `/index.html`. Check with `npm run build && npx vite preview` before deploying.
- All the games share one origin, so prefix `localStorage` keys with the game (for example `ra.name`). Crater Club uses `cc.`, Light Cycles `lc.`, Boom Room `br.`.
- After the first deploy, turn the game's "Coming soon" card in `../../hub/public/index.html` into a link and deploy the hub.

Ask before deploying, committing or pushing.
