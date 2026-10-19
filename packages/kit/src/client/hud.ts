// HUD pieces several games share: a turn clock, and a feed of what just happened.
import { $, setText } from "./dom";
import { formatClock } from "./format";

/**
 * Show what's left of a turn: `msLeft` as m:ss (or `fmt`'s way), nothing when it's null (no
 * clock running), and the class `low` once it's under `lowMs`. Returns the text, for a second
 * place that shows it.
 */
export function showClock(
  el: HTMLElement | null,
  msLeft: number | null,
  lowMs: number,
  fmt: (ms: number) => string = formatClock,
): string {
  const text = msLeft === null ? "" : fmt(msLeft);
  if (el) {
    setText(el, text);
    el.classList.toggle("low", msLeft !== null && msLeft < lowMs);
  }
  return text;
}

/** The most lines a feed shows. */
const FEED_MAX = 5;
/** Once the oldest line has been up this long, lines past `FEED_FADE_MS` get `old` (to fade)... */
const FEED_SHOW_MS = 5000;
const FEED_FADE_MS = 4400;
/** ...and lines past this go. */
const FEED_GONE_MS = 5200;

/**
 * The last few things that happened (knockouts, captures), as lines in the game's own list
 * (`<ol id="feed">` by default). Style `li.old` to fade a line out before it goes, and call
 * `age` every frame.
 */
export class Feed {
  private lines: { html: string; at: number }[] = [];

  constructor(private readonly id = "feed") {}

  /** Add a line (HTML), dropping the oldest past five. */
  push(html: string): void {
    this.lines.push({ html, at: performance.now() });
    if (this.lines.length > FEED_MAX) this.lines.shift();
    this.render();
  }

  /** Empty it (a new round, or leaving). */
  clear(): void {
    this.lines = [];
    this.render();
  }

  /** Fade and drop lines that have been up long enough. `now` is `performance.now()`'s clock. */
  age(now: number): void {
    if (!this.lines.some((l) => now - l.at > FEED_SHOW_MS)) return;
    for (const li of $(this.id).querySelectorAll<HTMLElement>("li")) {
      if (now - Number(li.dataset.at) > FEED_FADE_MS) li.classList.add("old");
    }
    if (!this.lines.some((l) => now - l.at > FEED_GONE_MS)) return;
    this.lines = this.lines.filter((l) => now - l.at <= FEED_GONE_MS);
    this.render();
  }

  private render(): void {
    $(this.id).innerHTML = this.lines.map((l) => `<li data-at="${l.at}">${l.html}</li>`).join("");
  }
}
