declare global {
  /** Set by `gameConfig` (Vite's `define`) to the same value in a build's client and worker. */
  var __WARRICK_BUILD__: string | undefined;
}

/** This build's id, so a room can tell a page running older code to reload. Null outside a Vite build (tests). */
export function buildId(): string | null {
  return typeof __WARRICK_BUILD__ === "string" ? __WARRICK_BUILD__ : null;
}
