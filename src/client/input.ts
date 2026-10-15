import type { Dir } from "../shared/movement";

const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: 1,
  ArrowRight: 2,
  ArrowDown: 3,
  ArrowLeft: 4,
  KeyW: 1,
  KeyD: 2,
  KeyS: 3,
  KeyA: 4,
};
const BOMB_KEYS = new Set(["Space", "KeyX", "Enter", "KeyK", "NumpadEnter"]);

/**
 * Keyboard, touch D-pad and gamepad, merged into "which way" and "drop a bomb".
 * With several directions held, the most recently pressed one wins.
 */
export class Input {
  private held: Dir[] = [];
  private touchDir: Dir = 0;
  private padDir: Dir = 0;
  private padBomb = false;

  constructor(
    /** Only listen while this says so (e.g. on the game screen). */
    private active: () => boolean,
    private onBomb: () => void,
  ) {
    window.addEventListener("keydown", (e) => this.keydown(e));
    window.addEventListener("keyup", (e) => {
      const d = KEY_DIRS[e.code] ?? KEY_DIRS[e.key];
      if (d) this.held = this.held.filter((h) => h !== d);
    });
    window.addEventListener("blur", () => this.clear());
    document.addEventListener("visibilitychange", () => this.clear());
  }

  dir(): Dir {
    if (this.touchDir) return this.touchDir;
    if (this.held.length) return this.held[this.held.length - 1];
    return this.padDir;
  }

  clear(): void {
    this.held = [];
    this.touchDir = 0;
  }

  private keydown(e: KeyboardEvent): void {
    if (!this.active()) return;
    const target = e.target as HTMLElement;
    if (target.closest?.("input, select, textarea")) return;
    const d = KEY_DIRS[e.code] ?? KEY_DIRS[e.key];
    if (d) {
      e.preventDefault();
      if (!e.repeat) this.held = [...this.held.filter((h) => h !== d), d];
      return;
    }
    if (BOMB_KEYS.has(e.code)) {
      // A focused button handles its own Space/Enter.
      if (target.closest?.("button") && (e.code === "Space" || e.code === "Enter")) return;
      e.preventDefault();
      if (!e.repeat) this.onBomb();
    }
  }

  /** Call once per animation frame. */
  pollGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    let dir: Dir = 0;
    let bomb = false;
    for (const pad of pads) {
      if (!pad?.connected) continue;
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (b(12)) dir = 1;
      else if (b(15)) dir = 2;
      else if (b(13)) dir = 3;
      else if (b(14)) dir = 4;
      else if (Math.max(Math.abs(ax), Math.abs(ay)) > 0.45) {
        dir = Math.abs(ax) > Math.abs(ay) ? (ax > 0 ? 2 : 4) : ay > 0 ? 3 : 1;
      }
      bomb ||= b(0) || b(1) || b(2) || b(3);
      if (dir || bomb) break;
    }
    this.padDir = dir;
    if (bomb && !this.padBomb && this.active()) this.onBomb();
    this.padBomb = bomb;
  }

  /** Wire up an on-screen D-pad: slide your thumb around it to steer. */
  attachDpad(pad: HTMLElement): void {
    let pointer: number | null = null;
    const update = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const dead = r.width * 0.12;
      const d: Dir = Math.hypot(dx, dy) < dead ? 0 : Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 2 : 4) : dy > 0 ? 3 : 1;
      this.touchDir = d;
      pad.dataset.dir = String(d);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      this.touchDir = 0;
      pad.dataset.dir = "0";
    };
    pad.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pointer = e.pointerId;
      try {
        pad.setPointerCapture(e.pointerId);
      } catch {
        // Not a live pointer (synthetic event); steering still works without capture.
      }
      update(e);
    });
    pad.addEventListener("pointermove", (e) => e.pointerId === pointer && update(e));
    pad.addEventListener("pointerup", end);
    pad.addEventListener("pointercancel", end);
  }

  attachBombButton(btn: HTMLElement): void {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      btn.classList.add("down");
      this.onBomb();
    });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(ev, () => btn.classList.remove("down"));
  }
}
