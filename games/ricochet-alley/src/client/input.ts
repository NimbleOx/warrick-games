import { HEADINGS, headingDiff, headingTo, wrapHeading } from "../shared/headings";
import { IN_DOWN, IN_LEFT, IN_RIGHT, IN_UP } from "../shared/sim";

/** Heading steps per degree. */
const DEG = HEADINGS / 360;

const KEY_BITS: Record<string, number> = {
  ArrowUp: IN_UP,
  ArrowDown: IN_DOWN,
  ArrowLeft: IN_LEFT,
  ArrowRight: IN_RIGHT,
  KeyW: IN_UP,
  KeyS: IN_DOWN,
  KeyA: IN_LEFT,
  KeyD: IN_RIGHT,
};

export interface ControlsHooks {
  /** Held bits changed. */
  change(bits: number): void;
  /** Fire was pressed. */
  fire(): void;
  /** Should keys drive the tank right now (game screen up, a round on)? */
  active(): boolean;
  /** Your tank's current heading, for turning the touch stick into turn/drive bits. Null if you have no tank. */
  heading(): number | null;
}

/**
 * Keyboard and touch input, boiled down to the four held bits plus fire presses. Only changes are reported.
 *
 * The touch stick is point-to-drive: push it the way you want to go and the tank turns to face that way,
 * driving once it's roughly facing it. That's translated here into the same bits the keyboard makes.
 */
export class Controls {
  private keys = new Set<string>();
  private keyBits = 0;
  private stickBits = 0;
  private stick: { x: number; y: number } | null = null;
  private stickId: number | null = null;
  private sent = 0;

  constructor(
    private h: ControlsHooks,
    private els: { stick: HTMLElement; knob: HTMLElement; fire: HTMLElement },
  ) {
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => this.releaseAll());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") this.releaseAll();
    });
    this.wireTouch();
  }

  get bits(): number {
    return this.sent;
  }

  /** Recompute the touch stick's bits as the tank turns; call every animation frame. */
  update(): void {
    this.stickBits = this.stickToBits();
    this.emit();
  }

  releaseAll(): void {
    this.keys.clear();
    this.keyBits = 0;
    this.stick = null;
    this.stickId = null;
    this.stickBits = 0;
    this.els.knob.style.transform = "";
    this.els.stick.classList.remove("active");
    this.emit();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const target = e.target as HTMLElement;
    const typing = !!target.closest?.("input, select, textarea");
    const bit = KEY_BITS[e.code];
    if (!down) {
      if (bit && this.keys.delete(e.code)) this.recomputeKeys();
      return;
    }
    if (typing || !this.h.active() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (bit) {
      e.preventDefault();
      if (!this.keys.has(e.code)) {
        this.keys.add(e.code);
        this.recomputeKeys();
      }
      return;
    }
    if (e.code === "Space" || e.code === "Enter") {
      // A focused button owns Space/Enter (it'll click itself); don't also fire.
      if (target.closest?.("button, a, summary")) return;
      e.preventDefault();
      if (!e.repeat) this.h.fire();
    }
  }

  private recomputeKeys(): void {
    let b = 0;
    for (const k of this.keys) b |= KEY_BITS[k] ?? 0;
    this.keyBits = b;
    this.emit();
  }

  private emit(): void {
    const bits = this.keyBits | this.stickBits;
    if (bits === this.sent) return;
    this.sent = bits;
    this.h.change(bits);
  }

  private stickToBits(): number {
    const s = this.stick;
    const heading = this.h.heading();
    if (!s || heading === null || !this.h.active()) return 0;
    if (Math.hypot(s.x, s.y) < 0.3) return 0;
    const want = headingTo(s.x, s.y);
    const diff = headingDiff(heading, want);
    let bits = 0;
    // Pulled almost straight back: reverse instead of spinning round.
    if (Math.abs(diff) > 150 * DEG) {
      const back = headingDiff(heading, wrapHeading(want + HEADINGS / 2));
      if (back > 3 * DEG) bits |= IN_RIGHT;
      else if (back < -3 * DEG) bits |= IN_LEFT;
      return bits | IN_DOWN;
    }
    if (diff > 3 * DEG) bits |= IN_RIGHT;
    else if (diff < -3 * DEG) bits |= IN_LEFT;
    if (Math.abs(diff) < 50 * DEG) bits |= IN_UP;
    return bits;
  }

  private wireTouch(): void {
    const { stick, knob, fire } = this.els;
    const move = (e: PointerEvent) => {
      const r = stick.getBoundingClientRect();
      const radius = r.width / 2;
      let x = (e.clientX - (r.left + radius)) / radius;
      let y = (e.clientY - (r.top + radius)) / radius;
      const len = Math.hypot(x, y);
      if (len > 1) {
        x /= len;
        y /= len;
      }
      this.stick = { x, y };
      knob.style.transform = `translate(${x * radius * 0.6}px, ${y * radius * 0.6}px)`;
      this.update();
    };
    stick.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.stickId = e.pointerId;
      try {
        stick.setPointerCapture(e.pointerId);
      } catch {
        // Not a live pointer (synthetic events); moves still arrive while it's over the stick.
      }
      stick.classList.add("active");
      move(e);
    });
    stick.addEventListener("pointermove", (e) => {
      if (e.pointerId === this.stickId) move(e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.stick = null;
      knob.style.transform = "";
      stick.classList.remove("active");
      this.update();
    };
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture"] as const) stick.addEventListener(ev, end);

    fire.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      fire.classList.add("down");
      if (this.h.active()) this.h.fire();
    });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"] as const) {
      fire.addEventListener(ev, () => fire.classList.remove("down"));
    }
    // The fire button is driven by pointerdown; don't let a click or Space on it fire twice.
    fire.addEventListener("click", (e) => e.preventDefault());
    fire.addEventListener("keydown", (e) => {
      if (e.code === "Space" || e.code === "Enter") e.preventDefault();
    });
  }
}
