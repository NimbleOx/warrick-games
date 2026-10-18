import { B_CCW, B_CW, B_DOWN, B_DROP, B_LEFT, B_RIGHT } from "../shared/bottle";

const KEYS: Record<string, number> = {
  ArrowLeft: B_LEFT,
  ArrowRight: B_RIGHT,
  ArrowDown: B_DOWN,
  ArrowUp: B_CW,
  a: B_LEFT,
  d: B_RIGHT,
  s: B_DOWN,
  w: B_CW,
  x: B_CW,
  z: B_CCW,
  " ": B_DROP,
};

/**
 * The buttons held, from the keyboard and the on-screen pad. Every press counts for at least one
 * tick, even a tap shorter than a tick, and two quick taps of one key count twice: the second
 * waits a tick so the bottle sees the key go up and down again.
 */
export class Controls {
  private held = 0;
  private taps: number[] = [];
  /** The buttons sent last tick. */
  private last = 0;
  private pointers = new Map<number, number>();

  constructor(private active: () => boolean) {
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => this.reset());
  }

  /** The buttons for the next tick. */
  sample(): number {
    let tap = 0;
    // A repeat of a key that was down last tick has to wait for it to come up first.
    if (this.taps.length && !(this.taps[0] & this.last & ~this.held)) tap = this.taps.shift()!;
    const m = this.held | tap;
    this.last = m;
    return this.active() ? m : 0;
  }

  reset(): void {
    this.held = 0;
    this.taps = [];
    this.last = 0;
    this.pointers.clear();
  }

  /** Wire up on-screen buttons marked with data-btn (a button bit). */
  bindPad(pad: HTMLElement): void {
    pad.addEventListener("pointerdown", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-btn]");
      if (!el || !this.active()) return;
      e.preventDefault();
      const bit = Number(el.dataset.btn);
      el.setPointerCapture?.(e.pointerId);
      el.classList.add("down");
      this.pointers.set(e.pointerId, bit);
      this.press(bit);
    });
    const up = (e: PointerEvent) => {
      const bit = this.pointers.get(e.pointerId);
      if (bit === undefined) return;
      this.pointers.delete(e.pointerId);
      for (const el of pad.querySelectorAll<HTMLElement>(`[data-btn="${bit}"]`)) el.classList.remove("down");
      this.release(bit);
    };
    pad.addEventListener("pointerup", up);
    pad.addEventListener("pointercancel", up);
    pad.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private press(bit: number): void {
    this.held |= bit;
    if (this.taps.length < 6) this.taps.push(bit);
  }

  private release(bit: number): void {
    this.held &= ~bit;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const bit = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (bit === undefined) return;
    if (!down) return this.release(bit);
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("input, select, textarea, [contenteditable]")) return;
    // A focused button owns Space and Enter.
    if (e.key === " " && target?.closest("button, a")) return;
    if (!this.active()) return;
    e.preventDefault();
    if (!e.repeat) this.press(bit);
  }
}
