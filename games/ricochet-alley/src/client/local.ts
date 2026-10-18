import { CpuBrain, type CpuLevel } from "../shared/ai";
import { DEFAULT_COLORS } from "@warrick/kit/shared/constants";
import { HANG_TICKS, MAZE_LOOPINESS, MAZE_SIZES, THEME_COUNT, TICK_MS, type MazeSize } from "../shared/constants";
import { headingRad } from "../shared/headings";
import { generateMaze, pickSpawns } from "../shared/maze";
import { mulberry32, randInt, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { World, startingTanks } from "../shared/sim";
import { sfx } from "./audio";
import { BulletField, lerpHeading } from "./predict";
import type { DrawTank, Renderer } from "./render";

export interface LocalOpts {
  /** Is tank 0 driven by the keyboard? */
  human: boolean;
  cpus: CpuLevel[];
  size: MazeSize;
  sound: boolean;
}

/**
 * A whole match run in the browser with no server: the home-screen demo (CPUs only) and the dev sandbox
 * (you against CPUs). It flies bullets through a BulletField exactly as the online client does, which
 * doubles as a check that the client's bullets match the authoritative ones.
 */
export class LocalMatch {
  world!: World;
  field!: BulletField;
  humanBits = 0;
  round = 0;
  wins: number[] = [];
  onRound: (() => void) | null = null;
  private brains: (CpuBrain | null)[] = [];
  private prev: { x: number; y: number; h: number }[] = [];
  private rng: Rng = mulberry32(randomSeed());
  private clock = 0;
  private hangUntil = -1;
  private nextRoundAt = 0;
  private names: string[];

  constructor(
    private renderer: Renderer,
    private opts: LocalOpts,
  ) {
    const n = (opts.human ? 1 : 0) + opts.cpus.length;
    this.names = Array.from({ length: n }, (_, i) => (opts.human && i === 0 ? "You" : `CPU ${i}`));
    this.wins = new Array(n).fill(0);
    this.newRound(performance.now());
  }

  get colors(): string[] {
    return this.names.map((_, i) => DEFAULT_COLORS[i % DEFAULT_COLORS.length]);
  }

  newRound(now: number): void {
    const { cols, rows } = MAZE_SIZES[this.opts.size];
    const maze = generateMaze(this.rng, cols, rows, MAZE_LOOPINESS);
    const ids = this.names.map((_, i) => `t${i}`);
    const tanks = startingTanks(ids, pickSpawns(maze, ids.length, this.rng));
    this.world = new World(maze, { tick: 0, nextId: 1, tanks, bullets: [] });
    this.field = new BulletField(this.world.walls.bullet);
    this.brains = ids.map((_, i) =>
      this.opts.human && i === 0 ? null : new CpuBrain(this.opts.cpus[i - (this.opts.human ? 1 : 0)], mulberry32(randomSeed())),
    );
    this.prev = tanks.map((t) => ({ x: t.x, y: t.y, h: t.h }));
    this.renderer.setMaze(maze, randInt(this.rng, 0, THEME_COUNT - 1));
    this.clock = now + 900; // a beat to look at the maze
    this.hangUntil = -1;
    this.nextRoundAt = 0;
    this.round++;
    this.onRound?.();
  }

  requestFire(): void {
    if (this.opts.human) this.world.requestFire(0);
  }

  private step(now: number): void {
    const w = this.world;
    const bits = w.tanks.map((_, i) => {
      const brain = this.brains[i];
      if (!brain) return this.humanBits;
      const m = brain.think(w, i);
      if (m.fire) w.requestFire(i);
      return m.bits;
    });
    this.prev = w.tanks.map((t) => ({ x: t.x, y: t.y, h: t.h }));
    for (const e of w.step(bits)) {
      if (e.k === "fire") {
        this.field.add(e.b, w.tick);
        this.renderer.muzzle(e.b.x, e.b.y, now);
        if (this.opts.sound) sfx.fire();
      } else if (e.k === "hit") {
        this.field.remove(e.b);
        this.renderer.explode(e.x, e.y, this.colors[e.t], now);
        if (this.opts.sound) sfx.boom();
      } else if (e.k === "empty" && this.opts.sound && e.t === 0 && this.opts.human) {
        sfx.empty();
      }
    }
    this.field.advance(w.tick, (x, y) => {
      this.renderer.spark(x, y, now);
      if (this.opts.sound) sfx.bounce();
    });
    if (import.meta.env.DEV && this.field.size !== w.bullets.length) {
      console.warn(
        "client bullets drifted from the world",
        this.field.ids(),
        w.bullets.map((b) => b.id),
      );
    }
    if (this.hangUntil < 0 && w.aliveCount <= 1) this.hangUntil = w.tick + HANG_TICKS;
    if (this.hangUntil >= 0 && w.tick >= this.hangUntil && !this.nextRoundAt) {
      const winner = w.tanks.findIndex((t) => t.alive);
      if (winner >= 0 && w.aliveCount === 1) this.wins[winner]++;
      this.nextRoundAt = now + 1500;
    }
  }

  get winnerIndex(): number | null {
    if (!this.nextRoundAt) return null;
    return this.world.aliveCount === 1 ? this.world.tanks.findIndex((t) => t.alive) : -1;
  }

  frame(now: number): void {
    if (this.nextRoundAt && now >= this.nextRoundAt) this.newRound(now);
    let steps = 0;
    if (now > this.clock + TICK_MS * 10) this.clock = now - TICK_MS; // tab was asleep
    while (now - this.clock >= TICK_MS && steps++ < 5) {
      this.clock += TICK_MS;
      this.step(now);
    }
    const f = Math.min(1, Math.max(0, (now - this.clock) / TICK_MS));
    const w = this.world;
    const tanks: DrawTank[] = [];
    w.tanks.forEach((t, i) => {
      if (!t.alive) return;
      const p = this.prev[i] ?? t;
      tanks.push({
        id: t.id,
        x: p.x + (t.x - p.x) * f,
        y: p.y + (t.y - p.y) * f,
        a: headingRad(lerpHeading(p.h, t.h, f)),
        color: this.colors[i],
        name: this.names[i],
        me: this.opts.human && i === 0,
      });
    });
    const bullets = this.field.positions(w.tick - 1 + f);
    this.renderer.draw({ tanks, bullets, findMe: this.opts.human && w.tick < 60, names: this.opts.human }, now);
  }
}
