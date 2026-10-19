# Pill Panic

A multiplayer, browser-based take on *Dr. Mario* for up to 8 players. Everyone gets the same bottle of germs and the same capsules; the first to clear their bottle wins the round, and big clears dump junk on your rivals. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/pill-panic/g/K7Q2M`. Send either one to your friends.
- The host picks the germ level (0–20: (level + 1) × 4 germs), the speed (low, medium, high), how many rounds win the match (1, 2, 3 or 5) and who junk goes to (whoever's winning, a random rival, or everyone), and can add CPU players (easy, normal or hard).
- Capsules drop into your bottle two halves at a time. Line up four or more of one color, across or down, to clear them. Germs count toward the four, and they don't fall; loose capsule halves do.
- Clear every germ in your bottle to win the round. If a new capsule has nowhere to go, you're out. The last player left in also wins the round.
- Clear two or more lines with one capsule, at once or in a chain, and you send one loose half per line (up to four) into a rival's bottle. It drops in after their current capsule lands.
- Gravity speeds up every 10 capsules.
- **Solo.** On your own in the lobby, the start button says **Play solo** and starts a run: clear the bottle and the next round is the next level up, with four more germs (up to level 20, which then repeats), until you top out. Germs score as in *Dr. Mario*: 100, 200 or 300 each by speed, and each more germ in the same combo twice the last, up to the sixth. The HUD shows the germs left, your score and the level; the end screen shows the levels you cleared, the level you topped out on, your score and germs, and your best score at that speed (kept in this browser). Anyone who arrives mid-run watches. Add a CPU or invite a friend and it's a match again.
- Keys: ←/→ (or A/D) move, ↓ (or S) drops faster, Space drops straight down, Z rotates left, X or ↑ (or W) rotates right. Touch screens get an on-screen pad.
- Reloading the page puts you back in your seat. Players who join mid-match play from the next round. Players who are offline when a round starts sit it out.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/pill-panic -- --port 5179  # http://localhost:5179/pill-panic/, with the Worker and Durable Object in workerd
npm test -w games/pill-panic                    # bottle rules, CPUs, the networked round, game-flow and room tests (Node)
npm run typecheck -w games/pill-panic
npm run test:live -w games/pill-panic           # two headless players and a CPU play a match through the dev server
```

`test:live` plays a whole match against a dev server that's already running (start it with the first command, or as `pill-panic` from `.claude/launch.json`). It expects the game at `http://localhost:5179/pill-panic`; set `PILL_PANIC_URL` if it's elsewhere. The room turns away a page from a different build (see the kit's README), so the test's players read the dev server's build id from `/@vite/env` and send it in their `hello`, as the page does. For a server that isn't a Vite dev server, set `PILL_PANIC_BUILD` to its build id (the `WARRICK_BUILD` it was built with).

## Deploying

`npm run deploy -w games/pill-panic` builds it and deploys it to **https://warrick.games/pill-panic/**. The root README explains how the games share warrick.games. `localStorage` keys start with `pp.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /pill-panic/api/games            → allocate a code, initialize that room
   │   GET  /pill-panic/api/games/:code      → does the game exist?
   └─WS─ /pill-panic/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code.** It holds the lobby and match state, each player's secret token, and the chat/event log in storage, and talks to browsers over hibernatable WebSockets. Rounds live in memory and state is saved at round boundaries. A deploy restarts every Durable Object; the first player back finds the round gone, and it starts over.
- **A bottle is a deterministic simulation.** `Bottle.step(buttons)` advances it one tick (60 a second) given the buttons held. The same seed, level and inputs give the same bottle anywhere, down to a checksum.
- **Your own bottle runs in your browser**, on the server's clock, so moving and turning capsules has no lag. The browser tells the server which buttons changed on which tick (`{t: "in", n, k, g}`), about 20 times a second.
- **The server replays every player's inputs** through its own copy of their bottle, and that copy is the one that counts: attacks, wins and top-outs all come from the server's replay. CPU bottles step on the server with the clock.
- **Everyone else's bottle is a mirror.** Every 50 ms the server broadcasts a frame: for each bottle, the inputs it replayed since the last frame and a checksum. Browsers replay those segments a few ticks behind, so other bottles move smoothly. A checksum mismatch or a gap makes the browser ask for a fresh snapshot.
- **Attacks** are aimed by the server and carry their columns and colors. CPU bottles take them at once. A player's browser drops each one into its bottle on the tick it arrives and reports that tick, so the server can replay it on the same tick. The tick has to be one the browser has reached, and no later than 2 seconds after the attack was sent; otherwise the server overrules the browser and drops the attack in itself. Where attacks land, and how the CPUs play, come from a random stream of the server's own, apart from the round's seed, so the seed everyone sees gives nothing away.
- **The server can overrule a browser.** If a browser falls more than 2 seconds behind the clock, doesn't take an attack within 2 seconds, or sends inputs that can't be replayed (out of order, or claiming a tick more than 3 seconds ahead of the clock), the server moves the bottle on itself and sends the owner a fix: a snapshot of the bottle and a new epoch. Inputs from the old epoch are ignored. Each round's bottles start at a random epoch, so inputs still in flight from the last round can't be mistaken for this one's.
- **Scores are part of the bottle.** Each bottle counts its own points as it clears germs, the same way everywhere, so your browser shows your score as you play. They don't change how a bottle plays, so the checksum leaves them out.
- **A solo run is a match of one.** The state says it's solo from the start (`solo`); each round is played a level higher, there's nobody to aim junk at, a cleared bottle starts the next level instead of counting toward a match, and the first top-out ends it. Nobody wins it, so it earns no trophy.
- **Rounds are decided in tick order.** Bottles finish at different moments in different browsers, so the server only settles a win or a top-out once every bottle still playing has been replayed past that tick.
- **CPU players** try every spot a capsule can reach by turning and sliding, score each by the germs it clears and the work it leaves (lines of one color that need filling, other colors piled on germs, tall stacks near the middle), and look one capsule ahead. Easy, normal and hard differ in reaction time, button speed, slop, and whether they drop capsules straight down.

### Layout

```
src/shared/    code used by both sides
  bottle.ts      the bottle: capsules, gravity, matching, chains, attacks, snapshots and checksums
  round.ts       Lane (a bottle plus queued inputs), Mirror (a replayed bottle), Round (the server's round)
  ai.ts          CPU players
  protocol.ts    settings, game state and message types
src/worker/    index.ts (routes), room.ts (Durable Object: inputs, clock pings, the loop), game.ts (match rules)
src/client/    main.ts (the game screen, the clock, and its hooks into the shell), view.ts (this browser's copy
               of the round), render.ts (canvas), input.ts (keys + touch pad), audio.ts (sounds),
               attract.ts (home-screen CPU demo)
test/          Vitest tests: bottle rules, the networked round, game flow; test/live checks a running server
```

The room, lobby rules, router, socket, home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`). Pill Panic keeps its own clock pings (timed by round trip, since every bottle runs on the server's clock): every 2 seconds while a match is on, and a few in quick succession during each round's countdown. None go in the lobby or on the results, so the room can hibernate there. It takes input messages up to 8 KB, twice what the kit allows, and up to 100 a second from one socket, counted apart from the kit's rate limit.
