export interface ControlHooks {
  /** Whether the player can give orders right now. */
  active(): boolean;
  /** The base at a point on the canvas (CSS px), or -1. */
  pick(sx: number, sy: number): number;
  mine(b: number): boolean;
  send(from: number[], to: number): void;
  /** The selection or the hover changed (not just the aim: the frame loop reads that itself). */
  changed(): void;
}

/** How far (CSS px) the pointer has to move before a press becomes a drag. */
const DRAG_PX = 8;

/**
 * Picking bases and giving orders, with a mouse or a finger:
 * - drag from one of your bases to any base to send there; sweep across more of yours on the way
 *   to send from them too;
 * - or tap one of your bases (shift-click for more), then tap the target;
 * - tap a selected base to drop it, or empty ground to clear.
 */
export class Controls {
  selected: number[] = [];
  hover = -1;
  /** The pointer while dragging out an order. */
  aim: { x: number; y: number } | null = null;
  private down: { x: number; y: number; base: number; wasSelected: boolean; add: boolean } | null = null;
  private dragging = false;

  constructor(
    private el: HTMLCanvasElement,
    private h: ControlHooks,
  ) {
    el.addEventListener("pointerdown", (e) => this.onDown(e));
    el.addEventListener("pointermove", (e) => this.onMove(e));
    el.addEventListener("pointerup", (e) => this.onUp(e));
    el.addEventListener("pointercancel", () => this.reset());
    el.addEventListener("pointerleave", () => {
      if (this.down) return;
      this.hover = -1;
      this.h.changed();
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  clear(): void {
    this.selected = [];
    this.reset();
  }

  /** Select every base in the list (all of yours). */
  selectAll(bases: number[]): void {
    this.selected = [...bases];
    this.h.changed();
  }

  /** Drop selected bases that aren't yours any more. */
  prune(): void {
    const kept = this.selected.filter((b) => this.h.mine(b));
    if (kept.length === this.selected.length) return;
    this.selected = kept;
    this.h.changed();
  }

  private reset(): void {
    this.down = null;
    this.dragging = false;
    this.aim = null;
    this.h.changed();
  }

  private local(e: PointerEvent): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private onDown(e: PointerEvent): void {
    if (!this.h.active()) return this.clear();
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const [x, y] = this.local(e);
    const base = this.h.pick(x, y);
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // Not all pointers can be captured (synthetic events in tests, say).
    }
    this.down = { x, y, base, wasSelected: this.selected.includes(base), add: e.shiftKey || e.metaKey || e.ctrlKey };
    this.dragging = false;
    // Show the pick at once, before the finger lifts or moves.
    if (base >= 0 && this.h.mine(base) && !this.selected.length) this.selected = [base];
    this.hover = base;
    this.h.changed();
  }

  private onMove(e: PointerEvent): void {
    const [x, y] = this.local(e);
    const base = this.h.pick(x, y);
    const d = this.down;
    // Moves come faster than frames: tell the hook only when the hover or the selection changes.
    let changed = base !== this.hover;
    if (d && this.h.active()) {
      if (!this.dragging && Math.hypot(x - d.x, y - d.y) > DRAG_PX && d.base >= 0 && this.h.mine(d.base)) {
        this.dragging = true;
        // Dragging from a base outside the selection starts a new one, unless adding.
        if (!this.selected.includes(d.base)) {
          this.selected = d.add ? [...this.selected, d.base] : [d.base];
          changed = true;
        }
      }
      if (this.dragging) {
        this.aim = { x, y };
        if (base >= 0 && this.h.mine(base) && !this.selected.includes(base)) {
          this.selected.push(base);
          changed = true;
        }
      }
    }
    this.hover = base;
    if (changed) this.h.changed();
  }

  private onUp(e: PointerEvent): void {
    const d = this.down;
    if (!d) return;
    const [x, y] = this.local(e);
    const base = this.h.pick(x, y);
    if (!this.h.active()) return this.clear();
    if (this.dragging) {
      if (base >= 0) {
        const from = this.selected.filter((s) => s !== base);
        if (from.length) this.h.send(from, base);
        this.selected = [];
      }
      // Let go over empty ground: keep the selection, so a tap can pick the target.
    } else if (d.base < 0) {
      if (!d.add) this.selected = [];
    } else if (d.add && this.h.mine(d.base)) {
      this.selected = d.wasSelected ? this.selected.filter((s) => s !== d.base) : [...this.selected, d.base];
    } else if (this.selected.length && !this.selected.includes(d.base)) {
      this.h.send(this.selected, d.base);
      this.selected = [];
    } else if (d.wasSelected) {
      this.selected = this.selected.filter((s) => s !== d.base);
    }
    this.down = null;
    this.dragging = false;
    this.aim = null;
    this.hover = base;
    this.h.changed();
  }
}
