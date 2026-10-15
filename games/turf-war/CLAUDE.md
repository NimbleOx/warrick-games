# Turf War

A territory-capture game like *Paper.io* and *Splix.io*. Each player owns a patch of the board. Leave it to draw a trail, then return to your land to claim everything the trail encloses. If anyone crosses your trail while you're outside, you're out.

## Rules for v1

- 2–8 players online, each on their own device. Arrows or WASD to turn; swipe on touch screens. Players move one cell per tick (about 8–10 cells a second) and can't reverse straight back.
- The board is a grid (start around 100 × 70 cells). Everyone spawns with a small 3 × 3 home patch.
- Claiming: when your head re-enters your own land, your trail and everything it encloses become yours. Find the enclosed area with a flood fill from the board edges: any cell the fill can't reach without crossing your land or trail is claimed.
- Kills: crossing someone's trail kills them, and you take their trail cells. Head-on collisions kill both.
- Rounds are timed (host picks; default 3 minutes). Dead players respawn after a few seconds with a fresh home patch and lose their old land. The biggest share of the board when time runs out wins. A live scoreboard shows each player's percentage.
- CPU players: wander out in a short loop and come home, and turn back early when an enemy gets near their trail.
- Not in v1: power-ups and a no-respawn battle-royale mode. Design so they can be added.

## Design notes

- A grid with discrete ticks is deterministic and cheap to network. Clients send direction changes; the server broadcasts per-tick changes (head moves, plus claimed cells as runs or bitmasks), and a full board snapshot on join or reconnect.
- Grid games tolerate latency well. Movement on the client can simply snap to each tick, with no prediction.

## How to build it

Copy the architecture of Crater Club, the turn-based artillery game in `../crater-club`. Read its README first. Sibling projects `../light-cycles` and `../boom-room` are being built the same way by other sessions — read them for ideas if useful, but don't modify them.

- Cloudflare Worker + Vite (`@cloudflare/vite-plugin`), TypeScript, no client framework, canvas rendering.
- One Durable Object per 5-character room code. `POST /api/games` creates a room, `/g/CODE` is the invite link, `/api/games/CODE/ws` is the WebSocket.
- No accounts: a random token in `localStorage` maps to a player slot, so a reload puts you back in your seat.
- Lobby: the host picks settings, can add CPU players, and starts the match. Up to 8 players.
- Reuse and adapt from Crater Club: `src/client/net.ts` (reconnecting socket), `src/worker/index.ts` (routing, code allocation), `src/worker/room.ts` (Durable Object, sockets, persistence, alarm), the lobby markup and styles in `index.html` and `src/client/style.css`, and the Vite / wrangler / tsconfig / Vitest setup.

### Real-time, unlike Crater Club

Crater Club is turn-based. This game is real-time:

- During a round, the Durable Object runs the authoritative simulation on a fixed tick with `setInterval`. Stop the loop between rounds so the object can hibernate.
- Clients send only input changes. The server broadcasts compact updates.
- Keep the simulation in `src/shared/` as pure functions, so Vitest can test it.
- Persist room state at round boundaries, not every tick.

## Lessons from Crater Club

- Deploying restarts every Durable Object and drops every socket. Clients must reconnect and resync from a full snapshot.
- When a button has keyboard focus, let it own Space/Enter; don't also fire game hotkeys.
- Make every limit visible. If something stops a player from acting, the UI must say why.
- Before attaching a custom domain, check DNS against the zone's authoritative nameservers (`dig @mina.ns.cloudflare.com <name>`), not the local resolver, which caches the "doesn't exist" answer for 30 minutes.

## Deploying

Cloudflare, same account as Crater Club. The game is served at `https://warrick.games/turf-war/`: a path on one shared site, not a subdomain. The hub page at the root is its own Worker in `../../hub` with the route `warrick.games/*`. This game gets its own Worker with a more specific route, and Cloudflare sends each request to the most specific matching route. Each game is its own folder under `games/` in this repo and its own Worker, and deploys on its own. Crater Club already works this way; copy its setup.

- `wrangler.jsonc`: `"routes": [{ "pattern": "warrick.games/turf-war*", "zone_name": "warrick.games" }]` (a zone route, not a custom domain), `workers_dev: false`, `preview_urls: false`, and `run_worker_first: ["/turf-war/api/*"]`.
- Vite `base: "/turf-war/"`. Build every client URL from `import.meta.env.BASE_URL`: fetches, the WebSocket, invite links (`/turf-war/g/CODE`) and the router's `history` paths. The Worker's API lives under `/turf-war/api/...`. Locally the game is at `http://localhost:<port>/turf-war/`.
- Static assets gotcha: Workers static assets are looked up by request path and ignore Vite's `base`. Vite writes `dist/client/assets/...`, but the page asks for `/turf-war/assets/...`, so every asset 404s in production while `npm run dev` looks fine. Copy the `nestClientUnderBase` plugin from Crater Club's `vite.config.ts`. It moves the client build into `dist/client/turf-war/` and leaves `index.html` at the root, because the single-page-application fallback always serves `/index.html`. Check with `npm run build && npx vite preview` before deploying.
- All the games share one origin, so prefix `localStorage` keys with the game (for example `tw.name`). Crater Club uses `cc.`, Light Cycles `lc.`, Boom Room `br.`.
- After the first deploy, turn the game's "Coming soon" card in `../../hub/public/index.html` into a link and deploy the hub.

Ask before deploying, committing or pushing.
