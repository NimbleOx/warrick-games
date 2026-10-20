import { IN_LEFT, IN_NUDGE, IN_PLUNGE, IN_RIGHT } from "../shared/sim";

const LEFT = ["ArrowLeft", "KeyZ", "ShiftLeft", "KeyA"];
const RIGHT = ["ArrowRight", "Slash", "ShiftRight", "KeyD", "KeyM"];
const PLUNGE = ["ArrowDown", "Space", "Enter", "KeyS"];
const NUDGE = ["ArrowUp", "KeyW"];
const GAME_KEYS = new Set([...LEFT, ...RIGHT, ...PLUNGE, ...NUDGE]);

/**
 * Your hands on the cabinet: the keyboard, and on a touch screen the two halves of the table
 * for the flippers and buttons for the plunger and the nudge. A key tapped between two frames
 * still counts as down for the ticks the next frame steps. Everything is let go when the page is
 * hidden or loses focus.
 */
export class Controls {
  private readonly held = new Set<string>();
  private readonly tapped = new Set<string>();
  /** Touches held, by what they do: "left", "right", "plunge" or "nudge". */
  private readonly touch = new Map<number, string>();
  /** Whether the controls answer: off when you're not playing. */
  enabled = false;

  constructor(private readonly onKey: (code: string) => void) {
    window.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Typing in chat isn't playing, and a focused button owns Space and Enter.
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
  }

  /**
   * The table on a touch screen: a touch on its left half holds the left flipper, on its right
   * half the right one. Each finger keeps its flipper until it lifts.
   */
  wireTable(el: HTMLElement): void {
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      this.press(e.pointerId, e.clientX - rect.left < rect.width / 2 ? "left" : "right");
      el.setPointerCapture(e.pointerId);
    });
    const up = (e: PointerEvent) => this.touch.delete(e.pointerId);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("lostpointercapture", up);
  }

  /** On-screen buttons: each has data-ctl="plunge" or "nudge". */
  wireButtons(buttons: HTMLElement[]): void {
    for (const b of buttons) {
      const ctl = b.dataset.ctl!;
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        this.press(e.pointerId, ctl);
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

  private press(id: number, ctl: string): void {
    this.touch.set(id, ctl);
    this.tapped.add(`touch:${ctl}`);
  }

  release(): void {
    this.held.clear();
    this.tapped.clear();
    this.touch.clear();
  }

  private down(codes: string[], ctl: string): boolean {
    if (codes.some((c) => this.held.has(c) || this.tapped.has(c))) return true;
    if (this.tapped.has(`touch:${ctl}`)) return true;
    for (const v of this.touch.values()) if (v === ctl) return true;
    return false;
  }

  /** The input bits held now (see IN_LEFT…). */
  read(): number {
    if (!this.enabled) return 0;
    return (
      (this.down(LEFT, "left") ? IN_LEFT : 0) |
      (this.down(RIGHT, "right") ? IN_RIGHT : 0) |
      (this.down(PLUNGE, "plunge") ? IN_PLUNGE : 0) |
      (this.down(NUDGE, "nudge") ? IN_NUDGE : 0)
    );
  }

  /** Call once the game has caught up: taps have had their ticks. */
  settle(): void {
    this.tapped.clear();
  }
}
