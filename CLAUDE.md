# Warrick Games

A monorepo of multiplayer browser games. Read `README.md` for the layout, commands and routing. Each game folder may have its own `CLAUDE.md` with that game's rules.

## Working here

- Several sessions may work in this checkout at once, usually one per game. Stay inside your game's folder (`games/<name>/`). Don't edit other games.
- The root `package.json`, `package-lock.json`, `.claude/launch.json`, `hub/` and `packages/kit/` are shared. Change them only when your task needs it, and say so in your report.
- `packages/kit` is code every game on it runs. Build new games on it, and reach for it before copying code from another game. A change to it reaches every game on it: keep it backwards compatible, run `npm test` and `npm run typecheck` at the root, and say which games need redeploying.
- Shared tooling goes in the root `devDependencies`. A dependency only one game uses goes in that game's `package.json` (`npm install <pkg> -w games/<name>`).
- Commit only the files you changed. Never stash, reset or switch branches: other sessions share the working tree.
- Run `npm run format` before committing. CI (`.github/workflows/ci.yml`) runs the format check, typecheck, tests and build on every push to main.
- Use your game's port from `.claude/launch.json`.
- Ask before deploying, committing or pushing.
