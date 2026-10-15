# Curve Ball

A browser multiplayer take on *Achtung, die Kurve* (also known as *Curve Fever*). Every player steers a line that is always moving forward; you can only turn left or right. Lines leave a permanent trail with short random gaps you can slip through. Touch any trail or the edge of the arena and you're out.

## Rules for v1

- 2–8 players online, each on their own device. Steer with ←/→ or A/D; on touch screens, hold the left or right half of the screen.
- A round: everyone spawns at a random spot and heading, a 3-second countdown, then go. Constant speed and turn rate.
- Trails have a gap every 1.5–3 seconds (random), a few pixels long. Gaps can be driven through.
- Scoring follows the original: whenever someone dies, every player still alive gets 1 point. The match ends when someone reaches the target (host picks it; default 10 × (players − 1)) with a 2-point lead.
- CPU players: cast a few rays ahead (left / straight / right) and steer toward the most open direction.
- Not in v1: power-ups (speed up, slow others, fat/thin lines, wrap-around walls, clear the board). Design so they can be added.

## Design notes

- Collision: keep trails in an occupancy bitmap of the arena. Each tick, test the pixels just ahead of each head, ignoring the player's own most recent pixels.
- Trails are a pure function of inputs and tick numbers, so the network traffic can stay tiny: clients send steering changes, the server broadcasts head positions (or input changes) per tick, plus a full snapshot on join or reconnect.

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

Cloudflare, same account as Crater Club. The game is served at `https://warrick.games/curve-ball/`: a path on one shared site, not a subdomain. The hub page at the root is its own Worker in `../../hub` with the route `warrick.games/*`. This game gets its own Worker with a more specific route, and Cloudflare sends each request to the most specific matching route. Each game is its own folder under `games/` in this repo and its own Worker, and deploys on its own. Crater Club already works this way; copy its setup.

- `wrangler.jsonc`: `"routes": [{ "pattern": "warrick.games/curve-ball*", "zone_name": "warrick.games" }]` (a zone route, not a custom domain), `workers_dev: false`, `preview_urls: false`, and `run_worker_first: ["/curve-ball/api/*"]`.
- Vite `base: "/curve-ball/"`. Build every client URL from `import.meta.env.BASE_URL`: fetches, the WebSocket, invite links (`/curve-ball/g/CODE`) and the router's `history` paths. The Worker's API lives under `/curve-ball/api/...`. Locally the game is at `http://localhost:<port>/curve-ball/`.
- Static assets gotcha: Workers static assets are looked up by request path and ignore Vite's `base`. Vite writes `dist/client/assets/...`, but the page asks for `/curve-ball/assets/...`, so every asset 404s in production while `npm run dev` looks fine. Copy the `nestClientUnderBase` plugin from Crater Club's `vite.config.ts`. It moves the client build into `dist/client/curve-ball/` and leaves `index.html` at the root, because the single-page-application fallback always serves `/index.html`. Check with `npm run build && npx vite preview` before deploying.
- All the games share one origin, so prefix `localStorage` keys with the game (for example `cb.name`). Crater Club uses `cc.`, Light Cycles `lc.`, Boom Room `br.`.
- After the first deploy, turn the game's "Coming soon" card in `../../hub/public/index.html` into a link and deploy the hub.

Ask before deploying, committing or pushing.
