import { mulberry32, randomSeed } from "@warrick/kit/shared/rng";
import { newBrain, think, type Brain, type CpuLevel } from "../shared/ai";
import { Battle } from "../shared/battle";
import { PLAYER_COLORS, TICK_MS } from "../shared/constants";
import { generateMap } from "../shared/map";
import { Renderer, type Look, type Scene } from "./render";

const LEVELS: CpuLevel[] = ["hard", "normal", "normal", "hard"];

/**
 * The home screen's backdrop: CPUs playing a real battle with the same simulation the server
 * runs, just locally. A new one starts when it's over.
 */
export class Attract {
  private renderer: Renderer;
  private battle: Battle | null = null;
  private brains: Brain[] = [];
  private looks: (Look | null)[] = [];
  private rng = mulberry32(randomSeed());
  private acc = 0;
  private last = 0;
  private overAt = 0;
  private still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
  }

  resize(): void {
    this.renderer.resize(window.innerWidth, window.innerHeight);
  }

  frame(now: number): void {
    if (!this.battle) this.start();
    const b = this.battle!;
    const dt = this.last ? Math.min(250, now - this.last) : 0;
    this.last = now;
    if (!this.still) this.acc += dt;
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      b.aliveSlots().forEach((s) => think(b, s, this.brains[s], this.rng, (cmd) => b.apply(cmd)));
      for (const ev of b.step()) if (ev.e === "take") this.renderer.flash(ev.b, this.looks[ev.by]?.color ?? "#fff");
    }
    if (b.over) {
      this.overAt ||= now;
      if (now - this.overAt > 3000) this.battle = null;
    }
    const scene: Scene = { battle: b, looks: this.looks, me: -1, t: b.n + this.acc / TICK_MS, selected: [], hover: -1, aim: null, pct: 50 };
    this.renderer.draw(scene, now);
  }

  private start(): void {
    const seed = Math.floor(this.rng() * 0xffffffff);
    const slots = LEVELS.map((_, i) => i);
    this.battle = new Battle(generateMap(seed, LEVELS.length, "medium"), { slots, countdown: 10, limit: 0 });
    this.brains = LEVELS.map((l) => newBrain(l));
    this.looks = LEVELS.map((_, i) => ({ color: PLAYER_COLORS[(i * 3) % PLAYER_COLORS.length], name: "" }));
    this.overAt = 0;
    this.acc = 0;
    this.resize();
  }
}
