import { steer } from "../shared/ai";
import { Arena, spawnPoints } from "../shared/arena";
import { PLAYER_COLORS, THEME_COUNT, tickMsFor } from "../shared/constants";
import { DEFAULT_SETTINGS, arenaConfig, type CpuLevel } from "../shared/protocol";
import { mulberry32, randInt, randomSeed, shuffle, type Rng } from "@warrick/kit/shared/rng";
import { Renderer, type RiderInfo } from "./render";

const TICK_MS = tickMsFor("classic");
const LEVELS: CpuLevel[] = ["hard", "hard", "normal", "normal", "normal", "easy"];

/** Self-playing demo race behind the home screen. */
export class Attract {
  private renderer: Renderer;
  private rng: Rng = mulberry32(randomSeed());
  private arena!: Arena;
  private riders = new Map<string, RiderInfo>();
  private levels: CpuLevel[] = [];
  private theme = 0;
  private lastTick = 0;
  private resetAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.reset(performance.now());
  }

  resize(): void {
    // The window's size, showing the middle of a race that covers it (at most 1600 CSS pixels
    // wide, scaled up past that): a canvas sized for the larger fit and cropped by CSS would draw
    // four times the pixels on a phone held upright.
    this.renderer.resizeCover(window.innerWidth, window.innerHeight, 1600);
  }

  frame(now: number): void {
    if (this.resetAt && now > this.resetAt) this.reset(now);
    if (now - this.lastTick > 1000) this.lastTick = now; // the tab was hidden: don't fast-forward
    let steps = 0;
    while (now - this.lastTick >= TICK_MS && steps++ < 4) {
      this.lastTick += TICK_MS;
      if (this.arena.aliveCount > 1) this.step(now);
    }
    this.renderer.draw(this.arena, { theme: this.theme, riders: this.riders, labels: false, tickMs: TICK_MS }, now);
  }

  private step(now: number): void {
    const arena = this.arena;
    arena.cycles.forEach((c, i) => {
      if (!c.alive) return;
      const move = steer(arena, i, this.levels[i], this.rng);
      if (move.dir !== null) arena.queueTurn(i, move.dir);
      if (move.boost) arena.requestBoost(i);
    });
    this.renderer.beforeFrame(arena, now);
    const f = arena.step();
    this.renderer.afterFrame(arena, f.e, now, (id) => this.riders.get(id)?.color ?? "#ffffff");
    if (arena.aliveCount <= 1 && !this.resetAt) this.resetAt = now + 2200;
  }

  private reset(now: number): void {
    const rng = this.rng;
    const n = randInt(rng, 4, 6);
    const cfg = arenaConfig({ ...DEFAULT_SETTINGS, arena: "medium", suddenDeath: 30 });
    const spots = spawnPoints(n, cfg.w, cfg.h, rng);
    const colors = shuffle(rng, [...PLAYER_COLORS]);
    this.riders.clear();
    this.levels = shuffle(rng, LEVELS.slice(0, n));
    const starts = spots.map((s, i) => {
      const id = `d${i}`;
      this.riders.set(id, { name: "", color: colors[i], you: false });
      return { id, ...s };
    });
    this.arena = Arena.create(cfg, starts);
    this.theme = randInt(rng, 0, THEME_COUNT - 1);
    this.renderer.reset(this.arena);
    this.resetAt = 0;
    this.lastTick = now + 500; // a beat before they launch
  }
}
