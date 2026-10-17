import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// Served at warrick.games/curve-ball/, next to the hub and the other games (see wrangler.jsonc).
const base = "/curve-ball/";

export default defineConfig({
  base,
  plugins: [cloudflare(), nestClientUnderBase()],
});

/**
 * Workers static assets are looked up by request path and know nothing about Vite's `base`, so
 * /curve-ball/assets/x.js has to be the file curve-ball/assets/x.js. Vite writes the client build
 * to the root of dist/client; this moves it into curve-ball/. index.html stays at the root, because
 * the single-page-application fallback always serves /index.html.
 */
function nestClientUnderBase(): Plugin {
  return {
    name: "nest-client-under-base",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    writeBundle({ dir }) {
      if (!dir) return;
      const target = path.join(dir, base);
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(dir)) {
        if (name === "index.html" || name.startsWith(".") || path.join(dir, name, "/") === target) continue;
        fs.renameSync(path.join(dir, name), path.join(target, name));
      }
    },
  };
}
