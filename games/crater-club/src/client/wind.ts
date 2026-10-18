import { WORLD_H, WORLD_W } from "../shared/constants";

/** While nothing else on the map moves, windy air redraws it this often and no more. */
const STEP_MS = 1000 / 30;
/** Streaks fly between these heights, measured down from the top of the map. */
const TOP = 24;
const BOTTOM = WORLD_H * 0.72;

interface Streak {
  /** The head, in canvas coordinates (y down). */
  x: number;
  y: number;
  len: number;
  /** World px per second, signed like the wind. */
  vx: number;
  /** Seconds since it faded in, and how long it lasts. */
  age: number;
  life: number;
  /** Where along its ripple it starts. */
  wave: number;
}

/**
 * Wisps of air blowing across the sky, so the wind can be seen as well as read: the harder it
 * blows, the more of them there are and the longer, brighter and faster they fly. Calm air has
 * none. With reduced motion they hold still, and their fading tails still point the way it blows.
 */
export class WindStreaks {
  private streaks: Streak[] = [];
  private wind = 0;
  private last = 0;
  private still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  /** Changes whenever the streaks would look different, for the renderer's frame key. */
  step(wind: number, now: number): number {
    return wind === 0 || this.still ? 0 : Math.floor(now / STEP_MS);
  }

  /** Draw onto a context already scaled to world units. `ui` is world units per CSS pixel. */
  draw(ctx: CanvasRenderingContext2D, wind: number, now: number, ui: number): void {
    if (wind !== this.wind) this.reset(wind);
    if (wind === 0) return;
    // A tab that comes back from the background picks up where it left off.
    const dt = this.still ? 0 : Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;

    const strength = Math.abs(wind);
    const peak = Math.min(0.6, 0.28 + strength * 0.016);
    const span = WORLD_W + 2 * 80;
    ctx.lineWidth = (1.2 + strength * 0.035) * ui;
    ctx.lineCap = "round";
    for (const s of this.streaks) {
      s.age += dt;
      if (s.age >= s.life) this.spawn(s, false);
      // Off one side, back on the other.
      s.x = ((((s.x + s.vx * dt + 80) % span) + span) % span) - 80;

      const fade = Math.sin((Math.PI * s.age) / s.life);
      const tail = s.x - Math.sign(s.vx) * s.len;
      const g = ctx.createLinearGradient(tail, s.y, s.x, s.y);
      g.addColorStop(0, "rgba(255, 255, 255, 0)");
      g.addColorStop(1, `rgba(255, 255, 255, ${peak * fade})`);
      ctx.strokeStyle = g;
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const f = i / 6;
        const ripple = Math.sin(s.wave + f * 4 + s.age * 3) * 1.4;
        if (i === 0) ctx.moveTo(tail, s.y + ripple);
        else ctx.lineTo(tail + (s.x - tail) * f, s.y + ripple);
      }
      ctx.stroke();
    }
  }

  private reset(wind: number): void {
    this.wind = wind;
    const strength = Math.abs(wind);
    const count = wind === 0 ? 0 : Math.min(40, 6 + Math.round(strength * 1.6));
    this.streaks = Array.from({ length: count }, () => {
      const s = { x: 0, y: 0, len: 0, vx: 0, age: 0, life: 0, wave: 0 };
      this.spawn(s, true);
      return s;
    });
  }

  /** Start a streak somewhere new. Partway through its life at first, so they don't all fade in at once. */
  private spawn(s: Streak, midway: boolean): void {
    const strength = Math.abs(this.wind);
    s.x = Math.random() * WORLD_W;
    s.y = TOP + Math.random() * (BOTTOM - TOP);
    s.len = (14 + strength * 2.6) * (0.7 + Math.random() * 0.6);
    s.vx = Math.sign(this.wind) * (24 + strength * 7) * (0.75 + Math.random() * 0.5);
    s.life = 1.4 + Math.random() * 1.8;
    // Held still, each one shows at its brightest.
    s.age = this.still ? s.life / 2 : midway ? Math.random() * s.life : 0;
    s.wave = Math.random() * Math.PI * 2;
  }
}
