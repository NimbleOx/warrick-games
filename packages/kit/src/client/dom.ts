export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Every game shares the warrick.games origin, so each one prefixes its localStorage keys.
let prefix = "game";

export function setStorePrefix(p: string): void {
  prefix = p;
}

/** Read a key (no value), write it, or remove it (null). Storage can be missing (private mode). */
export function store(key: string, value?: string | null): string | null {
  const k = `${prefix}.${key}`;
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
    t = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    store("token", t);
  }
  return t;
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
