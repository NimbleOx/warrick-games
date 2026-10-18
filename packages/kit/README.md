# @warrick/kit

What every Warrick game shares, so each game's folder holds only its game: rooms, the lobby, networking, the page around the game screen, base styles and the build config. Games import the TypeScript source directly (there's no build step) through the workspace link `node_modules/@warrick/kit`.

| Import | What it is |
| --- | --- |
| `@warrick/kit/vite` | `gameConfig(slug)`: the whole `vite.config.ts` (base path, Cloudflare plugin, client build nested under the base, the build id) |
| `@warrick/kit/tsconfig.base.json` | compiler options; `tsconfig.client.json` and `tsconfig.worker.json` extend it |
| `@warrick/kit/worker/router` | `gameWorker(slug)`: the Worker's API routes and room-code allocation |
| `@warrick/kit/worker/room` | `Room`: the Durable Object base (sockets, tokens, storage, cleanup, alarm timers, tick loop) |
| `@warrick/kit/worker/lobby` | `Lobby`: the shared rules (joining, host, CPUs, colours, settings, kick, leave, chat), `GameError`, `baseState` |
| `@warrick/kit/worker/turns` | the turn clock for turn-based games (see below) |
| `@warrick/kit/shared/protocol` | `BasePlayer`, `BaseState`, `LogEntry`, the lobby's client messages and the room's server messages |
| `@warrick/kit/shared/constants` | room codes, `MAX_PLAYERS`, the default colours, CPU levels, close codes |
| `@warrick/kit/shared/rng` | seeded random numbers (mulberry32), and `randomSeed()` from the platform's secure random numbers |
| `@warrick/kit/shared/build` | `buildId()`: the build's id, the same in its client and worker |
| `@warrick/kit/client/shell` | `Shell`: the home card (with the link back to the hub), create/join, the lobby, chat, connection status, leave, mute |
| `@warrick/kit/client/net` | the reconnecting WebSocket (it notices a dead one), with the heartbeat real-time games need, `ClockSync` and a `?lag=150` dev aid |
| `@warrick/kit/client/dom` | `$`, `$$`, `esc`, `setHtml` and `setText` (only when changed), `toast`, `store` (localStorage under the game's prefix), `personalBest` and `reloadOnce` |
| `@warrick/kit/client/color` | `hexToRgb`, `mix` and `rgba`: colour arithmetic for canvas drawing |
| `@warrick/kit/client/format` | `formatClock(ms)`: m:ss for HUD clocks |
| `@warrick/kit/client/audio` | the synthesized-sound core (`tone`, `noiseBurst`, mute); each game builds its own `sfx` |
| `@warrick/kit/style.css` | base styles: colours as custom properties, buttons, home, lobby, chat, modals, results table, toast |
| `@warrick/kit/testing/room` | runs a game's real `Room` in Node with fake sockets and storage, for its tests (see below) |

## How a game uses it

**Server.** The game's `Game` class extends `Lobby` and adds its rules: `start`, playing, finishing. Override anything that works differently (Crater Club keeps a leaving player's tank, so it overrides `leave`). Hooks: `createPlayer` (the game's own player fields), `betweenRounds` (when the lobby is open), `joinMidGame`, `resetForLobby`, `finishedPhase`, `maxPlayers` and `maxSpectators`, and optional `tick()` and `onTimer()`.

Its `GameRoom` extends `Room` with `newState` and `makeGame`, plus whichever it needs: `handle` (messages beyond the lobby's), `timerAt` (when the alarm should call `onTimer`, for turn timers), `tickMs` and `wantsLoop` (a tick loop for real-time games), `afterHello(game, pid)` and `welcome` (extra fields like a snapshot), `rateLimits` (how fast one socket may send), and `changedKeys` (its own storage keys, saved in the same write as the state). `looping` says whether the tick loop is running; in `afterHello`, that's whether it was running before this hello. `src/worker/index.ts` is three lines: export the room and `gameWorker("<slug>")`.

The room calls `onTimer` once `timerAt` has come. After a restart (every deploy restarts every room and closes every socket), the game's `setConnected` hears about each player who went, on the first event after it, so away timers start as they would for a dropped connection.

**Client.** `main.ts` creates a `Shell` with the home card's text, the settings' labels and choices, and hooks for its own messages and screen (`onMessage`, `onState`, `onScreen`, `onReset`, `confirmLeave`, `isLive`, `intercept`). The shell adds the home and lobby screens to the page, so `index.html` holds only the game screen. Buttons with `data-action="leave"`, `"start"` or `"lobby"` work anywhere; so do `.conn`, `[data-log]`, `form[data-chat]` and `#mute`. Call `shell.start()` once the game's own setup is done.

**Solo.** A game that can be played alone passes `min` 1 to `beginStart` and sets `minPlayers: 1` on its `Shell`. With one player in the lobby, the start button reads `soloLabel` ("Play solo" by default) and the lobby shows `soloRules` in place of `rules`. The game's own rules then decide what a round with one seat means: it can't end on "last one standing". `personalBest(key, run, score)` keeps the player's best score in this browser; give each run an id (like the code and round number) so showing its results again doesn't count it twice. The link `/<slug>/solo` (the hub's Solo button) creates a game and starts it solo straight away; without a saved name, the home card asks for one first and its create button reads `soloLabel`. In a game without solo play it's the home card.

**Builds.** `gameConfig` gives the client and the worker the same build id, and the shell sends it in `hello`. A room tells a page with a different id (or none, from before ids) to reload, and the shell reloads, at most once a minute so a deploy that's still rolling out can't loop it. Set `WARRICK_BUILD` to choose the id.

**Types.** A game's `worker-configuration.d.ts` holds only its own bindings: `npm run cf-typegen` in the game runs `wrangler types --include-runtime=false`. The Workers runtime's types are written once, into the kit's `worker-runtime.d.ts` (`npm run cf-typegen -w packages/kit`, for the `compatibility_date` in the kit's `wrangler.jsonc`, which matches the games'), and each game's `tsconfig.worker.json` includes that file.

**Clock.** `shell.skew` (and `shell.serverNow()`) follow the server's clock: from the quickest of the last few pings (each carries the client's clock, and the pong sends it back), or from the newest message until a ping is back. The shell pings on each welcome, and every 5 seconds while `isLive`.

**Styles.** The game's stylesheet starts with `@import "@warrick/kit/style.css";`, sets its colours in `:root` (`--accent`, `--accent-edge`, `--accent-ink`, `--accent-hi`, `--accent-hi-edge`, `--logo`, `--logo-shade`, `--logo-deep`, `--code-shade`, and for a different palette the surface colours), then styles its game screen.

## Turn clocks

`@warrick/kit/worker/turns` keeps the clock for whoever's turn it is, in a turn-based game. It's pure functions over three fields of the game's state, so the game passes its state (or an object of its own, if the names are taken):

- `turnDeadline: number | null`: when the turn ends by itself. Arm the timer for this (`timerAt`).
- `clockEnd?: number | null`: when the turn's clock runs out (null: no limit). A game saved before it had one gets it from `turnDeadline`.
- `clockTopUp?: boolean`: this turn's top-up is used.

And a constant `ClockRules`: `{ awayMs, backMinMs = 5000, lateMs = 5000 }`. Each function returns the new `turnDeadline`.

| Call | When | What happens |
| --- | --- | --- |
| `startTurnClock(s, rules, now, turnMs, here)` | a turn starts, or a move restarts the clock | the whole clock (`turnMs` null or 0: no limit); `awayMs` at most if the player isn't here |
| `turnHolderLeft(s, rules, now)` | the player whose turn it is goes | `awayMs` from now, or the clock if that's sooner |
| `turnHolderBack(s, rules, now)` | they come back | the clock they had, never more; with less than `backMinMs` left, `backMinMs`, once a turn; no limit, no deadline |
| `turnTimeUp(s, rules, now)` | the timer fires | true: the turn is over. False: not yet, or the deadline passed long ago unnoticed (the room was empty or restarting) and is now `awayMs` from now: re-arm |

Call `turnHolderLeft` and `turnHolderBack` from `setConnected` only when the player's `connected` actually changes (after `if (p.connected === connected) return`): a second tab, or a hello from someone already here, changes nothing. A sketch:

```ts
const CLOCK: ClockRules = { awayMs: AWAY_MS };

setConnected(id: string, connected: boolean): void {
  const p = this.player(id);
  if (!p || p.cpu || p.connected === connected) return;
  super.setConnected(id, connected);
  if (!this.isTurnOf(id)) return;
  const at = connected ? turnHolderBack(this.s, CLOCK, this.io.now()) : turnHolderLeft(this.s, CLOCK, this.io.now());
  this.s.timer = at === null ? null : { kind: "turn", at };
}

onTimer(): void {
  if (this.s.timer?.kind === "turn") {
    if (!turnTimeUp(this.s, CLOCK, this.io.now())) {
      this.s.timer = this.s.turnDeadline === null ? null : { kind: "turn", at: this.s.turnDeadline };
      return this.touch();
    }
    // The turn is over.
  }
}
```

## Testing a room

`@warrick/kit/testing/room` runs the game's real `GameRoom` in Node: `openRoom(GameRoom)` gives `connect(name, token?)` (a tab saying hello), `say(ws, msg)`, `drop(ws)`, `restart()` (a deploy: every socket closes and a new instance loads the same storage), `wake()` (hibernation: a new instance, the same sockets), and `room`, `storage` (`alarm()`, `puts()`, `data`) and `sockets`. Each `FakeSocket` keeps what it `received`, `you` (its player id) and `closedWith`, and can watch each message as it's sent (`onSend`). `internals(room)` shows the room's `state`, `live`, `tokens` and `log`.

The game's vitest config swaps the Workers runtime module for the kit's stub: `resolve: { alias: { "cloudflare:workers": "@warrick/kit/testing/cloudflare-workers" } }`. Move the clock with fake timers; alarms don't fire by themselves, so set the time to `storage.alarm()` and call `room.alarm()`. The kit's `test/room-lifecycle.test.ts` uses it throughout.

## Changing the kit

Every game that uses the kit picks up a change on its next build, and only on its next deploy. So:

- Keep changes backwards compatible, or update every game that uses the kit in the same change.
- Run `npm test` and `npm run typecheck` at the repo root, which cover every game, and play the games the change touches.
- Redeploy each game the change affects.

Every game in the repo is built on the kit, so any change here needs every game's tests to pass.
