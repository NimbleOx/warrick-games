# Hub

The page at **https://warrick.games/**: a list of the games, each linking to its own path. It's static files in `public/`, deployed as a Cloudflare Worker with no script on the route `warrick.games/*`. The [root README](../README.md) explains how the game routes take precedence over it.

```bash
npm run dev -w hub      # http://localhost:8787 (the root .claude/launch.json uses 5170)
npm run deploy -w hub   # wrangler deploy
```

- Keep the hub's own files at paths no game will use (`/style.css`, `/favicon.svg`, `/icons/`).
- Unknown paths get `public/404.html`.
- When a game goes live, turn its "Coming soon" card in `public/index.html` into a link (`href="/<name>/"`).
