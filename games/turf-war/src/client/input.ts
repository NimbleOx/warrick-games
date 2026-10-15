import { reverse, type Dir } from "../shared/board";

const KEYS: Record<string, Dir> = {
  ArrowUp: 0,
  ArrowRight: 1,
  ArrowDown: 2,
  ArrowLeft: 3,
  w: 0,
  d: 1,
  s: 2,
  a: 3,
  W: 0,
  D: 1,
  S: 2,
  A: 3,
};

/** A swipe this long (CSS px) is a turn; keep dragging for another. */
const SWIPE_PX = 24;

export interface Steering {
  /** Whether turns should be taken right now (in a round, alive, not typing). */
  active(): boolean;
  /** The head's current heading, and whether it may still set off in any direction. */
  head(): { dir: Dir; fresh: boolean } | null;
  send(d: Dir): void;
}

/**
 * Keyboard and swipe steering. Keeps a copy of the turns the server is still
 * holding for us (it applies one per tick), so a turn straight back or a repeat
 * of the last one is dropped here instead of being sent.
 */
export class Controls {
  private queue: Dir[] = [];

  constructor(
    private surface: HTMLElement,
    private s: Steering,
  ) {
    window.addEventListener("keydown", (e) => this.onKey(e));
    surface.addEventListener("pointerdown", (e) => this.onPointerDown(e));
  }

  /** Call when a tick moved our head: the server used up one queued turn. */
  ticked(): void {
    this.queue.shift();
  }

  /** Forget queued turns (death, spawn, new round). */
  reset(): void {
    this.queue = [];
  }

  steer(d: Dir): void {
    const head = this.s.head();
    if (!head || !this.s.active()) return;
    const ref = this.queue.length ? this.queue[this.queue.length - 1] : head.dir;
    if (d === ref) return;
    if (d === reverse(ref) && !(head.fresh && !this.queue.length)) return;
    if (this.queue.length >= 2) this.queue[this.queue.length - 1] = d;
    else this.queue.push(d);
    this.s.send(d);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("input, select, textarea, [contenteditable]")) return;
    const d = KEYS[e.key];
    if (d === undefined || !this.s.active()) return;
    e.preventDefault();
    this.steer(d);
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.s.active() || e.button > 0) return;
    let x = e.clientX;
    let y = e.clientY;
    const id = e.pointerId;
    this.surface.setPointerCapture?.(id);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const dx = ev.clientX - x;
      const dy = ev.clientY - y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
      this.steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0);
      x = ev.clientX;
      y = ev.clientY;
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      this.surface.removeEventListener("pointermove", move);
      this.surface.removeEventListener("pointerup", end);
      this.surface.removeEventListener("pointercancel", end);
    };
    this.surface.addEventListener("pointermove", move);
    this.surface.addEventListener("pointerup", end);
    this.surface.addEventListener("pointercancel", end);
  }
}
