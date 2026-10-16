# @warrick/kit

What every Warrick game shares, so each game's folder holds only its game: rooms, the lobby, networking, the page around the game screen, base styles and the build config. Games import the TypeScript source directly (there's no build step) through the workspace link `node_modules/@warrick/kit`.

| Import | What it is |
| --- | --- |
| `@warrick/kit/vite` | `gameConfig(slug)`: the whole `vite.config.ts` (base path, Cloudflare plugin, client build nested under the base) |
| `@warrick/kit/tsconfig.base.json` | compiler options; `tsconfig.client.json` and `tsconfig.worker.json` extend it |
| `@warrick/kit/worker/router` | `gameWorker(slug)`: the Worker's API routes and room-code allocation |
| `@warrick/kit/worker/room` | `Room`: the Durable Object base (sockets, tokens, storage, cleanup, alarm timers, tick loop) |
| `@warrick/kit/worker/lobby` | `Lobby`: the shared rules (joining, host, CPUs, colours, settings, kick, leave, chat), `GameError`, `baseState` |
| `@warrick/kit/shared/protocol` | `BasePlayer`, `BaseState`, `LogEntry`, the lobby's client messages and the room's server messages |
| `@warrick/kit/shared/constants` | room codes, `MAX_PLAYERS`, the default colours, CPU levels, close codes |
| `@warrick/kit/shared/rng` | seeded random numbers (mulberry32) |
| `@warrick/kit/client/shell` | `Shell`: the home card (with the link back to the hub), create/join, the lobby, chat, connection status, leave, mute |
| `@warrick/kit/client/net` | the reconnecting WebSocket, with the heartbeat real-time games need and a `?lag=150` dev aid |
| `@warrick/kit/client/dom` | `$`, `$$`, `esc`, `toast`, and `store` (localStorage under the game's prefix) |
| `@warrick/kit/client/audio` | the synthesized-sound core (`tone`, `noiseBurst`, mute); each game builds its own `sfx` |
| `@warrick/kit/style.css` | base styles: colours as custom properties, buttons, home, lobby, chat, modals, results table, toast |

## How a game uses it

**Server.** The game's `Game` class extends `Lobby` and adds its rules: `start`, playing, finishing. Override anything that works differently (Crater Club keeps a leaving player's tank, so it overrides `leave`). Hooks: `createPlayer` (the game's own player fields), `betweenRounds` (when the lobby is open), `joinMidGame`, `resetForLobby`, `finishedPhase`, `maxPlayers` and `maxSpectators`, and optional `tick()` and `onTimer()`.

Its `GameRoom` extends `Room` with `newState` and `makeGame`, plus whichever it needs: `handle` (messages beyond the lobby's), `timerAt` (when the alarm should call `onTimer`, for turn timers), `tickMs` and `wantsLoop` (a tick loop for real-time games), `afterHello` and `welcome` (extra fields like a snapshot), `rateLimits` (how fast one socket may send). `src/worker/index.ts` is three lines: export the room and `gameWorker("<slug>")`.

**Client.** `main.ts` creates a `Shell` with the home card's text, the settings' labels and choices, and hooks for its own messages and screen (`onMessage`, `onState`, `onScreen`, `onReset`, `confirmLeave`, `isLive`, `intercept`). The shell adds the home and lobby screens to the page, so `index.html` holds only the game screen. Buttons with `data-action="leave"`, `"start"` or `"lobby"` work anywhere; so do `.conn`, `[data-log]`, `form[data-chat]` and `#mute`. Call `shell.start()` once the game's own setup is done.

**Styles.** The game's stylesheet starts with `@import "@warrick/kit/style.css";`, sets its colours in `:root` (`--accent`, `--accent-edge`, `--accent-ink`, `--accent-hi`, `--accent-hi-edge`, `--logo`, `--logo-shade`, `--logo-deep`, `--code-shade`, and for a different palette the surface colours), then styles its game screen.

## Changing the kit

Every game that uses the kit picks up a change on its next build, and only on its next deploy. So:

- Keep changes backwards compatible, or update every game that uses the kit in the same change.
- Run `npm test` and `npm run typecheck` at the repo root, which cover every game, and play the games the change touches.
- Redeploy each game the change affects.

Every game in the repo is built on the kit, so any change here needs every game's tests to pass.
