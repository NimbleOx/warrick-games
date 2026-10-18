import { LEAN_MAX } from "../shared/constants";
import type { RideInput } from "../shared/ride";

const GAME_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD", "KeyR", "Space"]);

/** How far the mouse moves (px, with the pointer locked) from a full lean back to a full lean forward. */
const MOUSE_RANGE = 360;

/**
 * Your hands on the bars: the keyboard, the mouse (like the original: hold the button for gas,
 * move it left and right to lean, the right button brakes) and the touch buttons. A key tapped
 * between two frames still counts as down for the ticks the next frame steps. Everything is let
 * go when the page is hidden or loses focus.
 */
export class Controls {
  private readonly held = new Set<string>();
  private readonly tapped = new Set<string>();
  /** Touch buttons held, by what they do. */
  private readonly touch = new Map<number, string>();
  /** The mouse: its buttons, and where it is from -1 (back) to 1 (forward) while the pointer is locked. */
  private mouseGas = false;
  private mouseBrake = false;
  mouseLean = 0;
  /** The pointer is locked to the game: the mouse steers. */
  locked = false;
  /** Whether the controls answer: off when you're not riding. */
  enabled = false;

  constructor(
    canvas: HTMLElement,
    private readonly onKey: (code: string) => void,
  ) {
    window.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Typing in chat isn't riding, and a focused button owns Space and Enter.
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, select, textarea")) return;
      if (target?.closest("button") && (e.code === "Space" || e.code === "Enter")) return;
      if (GAME_KEYS.has(e.code) && this.enabled) e.preventDefault();
      if (!e.repeat) this.onKey(e.code);
      this.held.add(e.code);
      this.tapped.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.held.delete(e.code));
    window.addEventListener("blur", () => this.release());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.release();
    });

    // The mouse, like the original: click the course to take it.
    canvas.addEventListener("mousedown", (e) => {
      if (!this.enabled) return;
      if (!this.locked) {
        if (e.button === 0) void canvas.requestPointerLock?.();
        return;
      }
      if (e.button === 0) this.mouseGas = true;
      if (e.button === 2) this.mouseBrake = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseGas = false;
      if (e.button === 2) this.mouseBrake = false;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      this.mouseLean = 0;
      this.mouseGas = this.mouseBrake = false;
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.mouseLean = Math.max(-1, Math.min(1, this.mouseLean + (2 * e.movementX) / MOUSE_RANGE));
    });
  }

  /** Wires the touch buttons: each has data-ctl="gas", "brake", "back", "forward" or "reset". */
  wireTouch(buttons: HTMLElement[]): void {
    for (const b of buttons) {
      const ctl = b.dataset.ctl!;
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        this.touch.set(e.pointerId, ctl);
        b.classList.add("down");
      });
      const up = (e: PointerEvent) => {
        this.touch.delete(e.pointerId);
        if (![...this.touch.values()].includes(ctl)) b.classList.remove("down");
      };
      b.addEventListener("pointerup", up);
      b.addEventListener("pointercancel", up);
      b.addEventListener("lostpointercapture", up);
    }
  }

  release(): void {
    this.held.clear();
    this.tapped.clear();
    this.touch.clear();
    this.mouseGas = this.mouseBrake = false;
  }

  /** Let go of the pointer lock (the course is over). */
  unlock(): void {
    if (this.locked) document.exitPointerLock?.();
  }

  private down(...codes: string[]): boolean {
    return codes.some((c) => this.held.has(c) || this.tapped.has(c));
  }

  private touching(ctl: string): boolean {
    for (const v of this.touch.values()) if (v === ctl) return true;
    return false;
  }

  read(into: RideInput): RideInput {
    if (!this.enabled) {
      into.throttle = into.brake = into.lean = into.respawn = 0;
      return into;
    }
    into.throttle = this.down("ArrowUp", "KeyW", "Space") || this.mouseGas || this.touching("gas") ? 1 : 0;
    into.brake = this.down("ArrowDown", "KeyS") || this.mouseBrake || this.touching("brake") ? 1 : 0;
    const back = this.down("ArrowLeft", "KeyA") || this.touching("back");
    const forward = this.down("ArrowRight", "KeyD") || this.touching("forward");
    if (back !== forward) into.lean = back ? -LEAN_MAX : LEAN_MAX;
    else if (this.locked) into.lean = Math.round(this.mouseLean * LEAN_MAX);
    else into.lean = 0;
    into.respawn = this.down("KeyR") || this.touching("reset") ? 1 : 0;
    return into;
  }

  /** Whether the gas is held, during the countdown (to rev). */
  get revving(): boolean {
    return this.down("ArrowUp", "KeyW", "Space") || this.mouseGas || this.touching("gas");
  }

  /** Call once the sim has caught up: taps have had their ticks. */
  settle(): void {
    this.tapped.clear();
  }
}
