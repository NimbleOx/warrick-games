# Warrick Games

A monorepo of multiplayer browser games. Read `README.md` for the layout, commands and routing. Before changing a game, read its `README.md` (how it plays and how it's built) and, where it has one, its `CLAUDE.md` (the rules and design its code keeps to). The kit's `packages/kit/README.md` says what every game shares.

## Working here

- Several sessions may work in this checkout at once, usually one per game. Stay inside your game's folder (`games/<name>/`). Don't edit other games.
- The root `package.json`, `package-lock.json`, `.claude/launch.json`, `hub/` and `packages/kit/` are shared. Change them only when your task needs it, and say so in your report.
- `packages/kit` is code every game on it runs. Build new games on it, and reach for it before copying code from another game. A change to it reaches every game on it: keep it backwards compatible, run `npm test` and `npm run typecheck` at the root, and say which games need redeploying.
- Shared tooling goes in the root `devDependencies`. A dependency only one game uses goes in that game's `package.json` (`npm install <pkg> -w games/<name>`).
- Commit only the files you changed. Never stash, reset or switch branches: other sessions share the working tree.
- Run `npm run format` before committing, and `npm test` and `npm run typecheck` for what you changed.
- Use your game's port from `.claude/launch.json`.
- Ask before deploying, committing or pushing.

## Lessons from building these games

- Deploying restarts every Durable Object and drops every socket. Clients reconnect on their own, but each game must resync from a full snapshot and cope with its in-memory round being gone.
- A background tab (or a hidden preview pane) doesn't run `requestAnimationFrame`, so nothing the game needs may wait on an animation. Drive animation queues with timers, or snap to the latest state.
- When a button has keyboard focus, let it own Space/Enter, and don't also fire game hotkeys. Blur buttons after clicks on the game screen, so the keys go back to the game.
- Make every limit visible. If something stops a player from acting, the UI must say why.
- A message that carries `state` stands in for the room's own state message (see the kit's `Room.flush`), so it must carry the state as it was after that message.
- Tests on a random seed must not assume who wins or what a CPU does on a given tick: pin the seed or set up the board, or check what holds either way.
- CPU-only simulations are cheap, so measure CPU strength and seat balance over a few hundred games, never one.
