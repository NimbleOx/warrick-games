import fs from "node:fs";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin, type UserConfig } from "vite";

/**
 * The Vite config for a game served at warrick.games/<slug>/, next to the hub and the other
 * games: the base path, the Cloudflare plugin (Worker + Durable Object in workerd during dev),
 * and the client build nested under the base path. Pass `extra` for anything a game adds.
 */
export function gameConfig(slug: string, extra: UserConfig = {}) {
  const base = `/${slug}/`;
  return defineConfig({
    ...extra,
    base,
    plugins: [cloudflare(), nestClientUnderBase(base), ...(extra.plugins ?? [])],
  });
}

/**
 * Workers static assets are looked up by request path and know nothing about Vite's `base`, so
 * /<slug>/assets/x.js has to be the file <slug>/assets/x.js. Vite writes the client build to
 * the root of dist/client; this moves it into <slug>/. index.html stays at the root, because
 * the single-page-application fallback always serves /index.html.
 */
function nestClientUnderBase(base: string): Plugin {
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
