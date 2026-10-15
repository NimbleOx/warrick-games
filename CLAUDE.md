# Warrick Games

A monorepo of multiplayer browser games. Read `README.md` for the layout, commands and routing. Each game folder may have its own `CLAUDE.md` with that game's rules.

## Working here

- Several sessions may work in this checkout at once, usually one per game. Stay inside your game's folder (`games/<name>/`). Don't edit other games.
- The root `package.json`, `package-lock.json`, `.claude/launch.json` and `hub/` are shared. Change them only when your task needs it, and say so in your report.
- Shared tooling goes in the root `devDependencies`. A dependency only one game uses goes in that game's `package.json` (`npm install <pkg> -w games/<name>`).
- Commit only the files you changed. Never stash, reset or switch branches: other sessions share the working tree.
- Use your game's port from `.claude/launch.json`.
- Ask before deploying, committing or pushing.
