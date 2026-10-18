import { DOWN, LEFT, RIGHT, UP, type Dir } from "../shared/engine";

const KEYS: Record<string, Dir> = {
  ArrowUp: UP,
  ArrowRight: RIGHT,
  ArrowDown: DOWN,
  ArrowLeft: LEFT,
  KeyW: UP,
  KeyD: RIGHT,
  KeyS: DOWN,
  KeyA: LEFT,
};

export interface InputHandlers {
  /** Whether moves go to the game right now. */
  active(): boolean;
  move(dir: Dir): void;
}

/**
 * Arrow keys or WASD, and swipes (or mouse drags) on the play area. A held key moves once, not
 * on every repeat, so a long press can't throw away a board.
 */
export class Input {
  private start: { id: number; x: number; y: number; fired: boolean } | null = null;

  constructor(
    private h: InputHandlers,
    surface: HTMLElement,
  ) {
    window.addEventListener("keydown", (e) => {
      const dir = KEYS[e.code];
      if (dir === undefined || e.ctrlKey || e.metaKey || e.altKey || !this.h.active()) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, select, textarea, [contenteditable]")) return;
      e.preventDefault();
      if (!e.repeat) this.h.move(dir);
    });

    surface.addEventListener("pointerdown", (e) => {
      if (!this.h.active() || (e.pointerType === "mouse" && e.button !== 0)) return;
      this.start = { id: e.pointerId, x: e.clientX, y: e.clientY, fired: false };
      surface.setPointerCapture?.(e.pointerId);
    });
    surface.addEventListener("pointermove", (e) => {
      const s = this.start;
      if (!s || s.fired || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      // Move as soon as the swipe is long enough, rather than waiting for the finger to lift.
      const min = Math.max(22, Math.min(window.innerWidth, window.innerHeight) * 0.05);
      if (Math.hypot(dx, dy) < min) return;
      s.fired = true;
      if (this.h.active()) this.h.move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RIGHT : LEFT) : dy > 0 ? DOWN : UP);
    });
    const end = (e: PointerEvent) => {
      if (this.start?.id === e.pointerId) this.start = null;
    };
    surface.addEventListener("pointerup", end);
    surface.addEventListener("pointercancel", end);
  }
}
