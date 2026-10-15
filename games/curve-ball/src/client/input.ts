import type { Steer } from "../shared/sim";

const LEFT_KEYS = new Set(["ArrowLeft", "a", "A"]);
const RIGHT_KEYS = new Set(["ArrowRight", "d", "D"]);

/**
 * Turns keys and touches into a steering value. Left and right held together
 * cancel out. On touch screens, a finger on the left half of the screen steers
 * left and one on the right half steers right.
 */
export class Steering {
  private keysLeft = new Set<string>();
  private keysRight = new Set<string>();
  /** Active touches: pointer id → which half of the screen it went down on. */
  private touches = new Map<number, -1 | 1>();
  private current: Steer = 0;

  constructor(
    /** Only steer while this says so (a round is on and you have a head). */
    private active: () => boolean,
    private onChange: (s: Steer) => void,
  ) {
    window.addEventListener("keydown", (e) => this.key(e, true));
    window.addEventListener("keyup", (e) => this.key(e, false));
    window.addEventListener("blur", () => this.releaseAll());
    document.addEventListener("visibilitychange", () => document.hidden && this.releaseAll());
    window.addEventListener("pointerdown", (e) => this.pointerDown(e), { passive: false });
    for (const ev of ["pointerup", "pointercancel"] as const) {
      window.addEventListener(ev, (e) => this.pointerUp(e));
    }
  }

  get value(): Steer {
    return this.current;
  }

  /** Forget everything held, e.g. when a round ends. */
  releaseAll(): void {
    this.keysLeft.clear();
    this.keysRight.clear();
    this.touches.clear();
    this.update();
  }

  private key(e: KeyboardEvent, down: boolean): void {
    const left = LEFT_KEYS.has(e.key);
    const right = RIGHT_KEYS.has(e.key);
    if (!left && !right) return;
    // Text fields and menus keep their arrow keys.
    if (down && e.target instanceof Element && e.target.closest("input, select, textarea")) return;
    const set = left ? this.keysLeft : this.keysRight;
    if (down) {
      if (!this.active()) return;
      e.preventDefault();
      set.add(e.code || e.key);
    } else {
      set.delete(e.code || e.key);
    }
    this.update();
  }

  private pointerDown(e: PointerEvent): void {
    if (e.pointerType === "mouse" || !this.active()) return;
    if (e.target instanceof Element && e.target.closest("button, input, select, textarea, a, .side-col, .topbar, .modal")) return;
    e.preventDefault();
    this.touches.set(e.pointerId, e.clientX < window.innerWidth / 2 ? -1 : 1);
    this.update();
  }

  private pointerUp(e: PointerEvent): void {
    if (!this.touches.delete(e.pointerId)) return;
    this.update();
  }

  private update(): void {
    let left = this.keysLeft.size > 0;
    let right = this.keysRight.size > 0;
    for (const side of this.touches.values()) {
      if (side < 0) left = true;
      else right = true;
    }
    const next: Steer = left === right ? 0 : left ? -1 : 1;
    if (next === this.current) return;
    this.current = next;
    this.onChange(next);
  }
}
