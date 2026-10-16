import type { Action } from "./pilot";

const KEYS: Record<string, Action> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowDown: "soft",
  " ": "hard",
  ArrowUp: "cw",
  x: "cw",
  X: "cw",
  z: "ccw",
  Z: "ccw",
  Control: "ccw",
  c: "hold",
  C: "hold",
  Shift: "hold",
};

export interface InputTarget {
  /** Whether keys should drive the piece right now (in a round, alive, not typing). */
  active(): boolean;
  press(a: Action): void;
  release(a: Action): void;
}

/**
 * Keyboard and on-screen buttons. Both report presses and releases; the pilot does its own
 * auto-repeat, so the keyboard's repeat is ignored.
 */
export class Input {
  private held = new Set<Action>();

  constructor(
    private t: InputTarget,
    buttons: HTMLElement,
  ) {
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => this.releaseAll());
    document.addEventListener("visibilitychange", () => this.releaseAll());
    for (const b of buttons.querySelectorAll<HTMLElement>("[data-act]")) this.wireButton(b);
  }

  releaseAll(): void {
    for (const a of this.held) this.t.release(a);
    this.held.clear();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.metaKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("input, select, textarea, [contenteditable]")) return;
    const a = KEYS[e.key];
    if (!a) return;
    // A focused button owns Space and Enter.
    if (a === "hard" && target?.closest("button")) return;
    if (!down) {
      if (this.held.delete(a)) this.t.release(a);
      return;
    }
    if (!this.t.active()) return;
    e.preventDefault();
    if (e.repeat || this.held.has(a)) return;
    this.held.add(a);
    this.t.press(a);
  }

  private wireButton(b: HTMLElement): void {
    const a = b.dataset.act as Action;
    const up = (e: PointerEvent) => {
      e.preventDefault();
      b.classList.remove("down");
      if (this.held.delete(a)) this.t.release(a);
    };
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      b.setPointerCapture?.(e.pointerId);
      if (!this.t.active() || this.held.has(a)) return;
      b.classList.add("down");
      this.held.add(a);
      this.t.press(a);
    });
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
  }
}
