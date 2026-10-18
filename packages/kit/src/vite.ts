import fs from "node:fs";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin, type UserConfig } from "vite";

/**
 * The Vite config for a game served at warrick.games/<slug>/, next to the hub and the other
 * games: the base path, the Cloudflare plugin (Worker + Durable Object in workerd during dev),
 * the client build nested under the base path, and a build id shared by the client and the
 * worker (see `buildId`). Pass `extra` for anything a game adds.
 */
export function gameConfig(slug: string, extra: UserConfig = {}) {
  const base = `/${slug}/`;
  // Vite loads the config once per environment, so the id is kept for the whole build (or dev
  // server): the client and the worker must agree. Set WARRICK_BUILD to choose it.
  const build = (process.env.WARRICK_BUILD ??= Date.now().toString(36));
  return defineConfig({
    ...extra,
    base,
    define: { __WARRICK_BUILD__: JSON.stringify(build), ...extra.define },
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
