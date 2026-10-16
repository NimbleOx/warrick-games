import { LEAN_MAX } from "../shared/constants";
import type { RideInput } from "../shared/ride";

const GAME_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD", "KeyR"]);

/**
 * The keyboard: which keys are down. A key tapped between two frames still counts as down for
 * the ticks the next frame steps. Everything is released when the page is hidden or loses focus.
 */
export class Keys {
  private readonly held = new Set<string>();
  private readonly tapped = new Set<string>();

  constructor(target: Window, onPress: (code: string) => void) {
    target.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) onPress(e.code);
      this.held.add(e.code);
      this.tapped.add(e.code);
    });
    target.addEventListener("keyup", (e) => this.held.delete(e.code));
    target.addEventListener("blur", () => this.release());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.release();
    });
  }

  private release(): void {
    this.held.clear();
    this.tapped.clear();
  }

  private down(...codes: string[]): boolean {
    return codes.some((c) => this.held.has(c) || this.tapped.has(c));
  }

  read(into: RideInput): RideInput {
    into.throttle = this.down("ArrowUp", "KeyW") ? 1 : 0;
    into.brake = this.down("ArrowDown", "KeyS") ? 1 : 0;
    const back = this.down("ArrowLeft", "KeyA");
    const forward = this.down("ArrowRight", "KeyD");
    into.lean = back === forward ? 0 : back ? -LEAN_MAX : LEAN_MAX;
    into.respawn = this.down("KeyR") ? 1 : 0;
    return into;
  }

  /** Call once the sim has caught up: taps have had their ticks. */
  settle(): void {
    this.tapped.clear();
  }
}
