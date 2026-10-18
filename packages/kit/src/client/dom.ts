export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Set an element's markup, unless it's what this last set. Rebuilding markup that hasn't changed
 * restarts its animations, loses hover and focus, and costs layout, so a HUD redrawn every frame
 * goes through here.
 */
export function setHtml(el: HTMLElement, html: string): void {
  if (el.dataset.html === html) return;
  el.innerHTML = html;
  el.dataset.html = html;
}

/** Set an element's text, unless it already says that. */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

// Every game shares the warrick.games origin, so each one prefixes its localStorage keys.
let prefix = "game";

export function setStorePrefix(p: string): void {
  prefix = p;
}

/** Read a key (no value), write it, or remove it (null). Storage can be missing (private mode). */
export function store(key: string, value?: string | null): string | null {
  return storeRaw(`${prefix}.${key}`, value);
}

/** The key every game keeps the player's name under: they share the warrick.games origin, so it follows them. */
const SHARED_NAME = "warrick.name";

/**
 * The name the player last used in any game. A name saved by this game alone, from before names
 * were shared, still counts until the player saves one.
 */
export function sharedName(): string | null {
  return storeRaw(SHARED_NAME) || store("name");
}

/** Remember the player's name for every game. */
export function saveSharedName(name: string): void {
  storeRaw(SHARED_NAME, name);
}

function storeRaw(k: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(k);
    if (value === null) localStorage.removeItem(k);
    else localStorage.setItem(k, value);
  } catch {
    // Private mode etc. — the setting just won't survive a reload.
  }
  return value ?? null;
}

/** This browser's secret player token: it maps to a seat in each room, so a reload keeps your place. */
export function playerToken(): string {
  let t = store("token");
  if (!t || !/^[\w-]{8,64}$/.test(t)) {
    t =
      crypto.randomUUID?.() ??
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    store("token", t);
  }
  return t;
}

/**
 * Reload the page, unless this tab already did in the last `guardMs`: a deploy still rolling out
 * can serve the old page again, and reloading again would loop. False if it didn't reload (no
 * session storage counts too, since nothing would stop a loop).
 */
export function reloadOnce(key: string, guardMs = 60_000): boolean {
  try {
    if (Date.now() - (Number(sessionStorage.getItem(key)) || 0) <= guardMs) return false;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return false;
  }
  location.reload();
  return true;
}

let toastTimer = 0;
export function toast(text: string, kind: "error" | "info" = "error"): void {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 3200);
}
