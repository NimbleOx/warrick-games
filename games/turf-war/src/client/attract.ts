import { newBrain, think, type Brain, type CpuLevel } from "../shared/ai";
import { PLAYER_COLORS, TICK_MS } from "../shared/constants";
import { mulberry32, randomSeed, shuffle } from "../shared/rng";
import { Round } from "../shared/sim";
import { Renderer, type Look, type Scene } from "./render";

/** CSS pixels per cell on the home screen. */
const CELL = 16;
const PLAYERS = 6;
const LEVELS: CpuLevel[] = ["hard", "normal", "hard", "easy", "normal", "hard"];

/**
 * The home screen's backdrop: CPUs playing a real round with the same
 * simulation the server runs, just locally and with nobody watching the score.
 */
export class Attract {
  private renderer: Renderer;
  private round: Round | null = null;
  private brains: Brain[] = [];
  private looks: (Look | null)[] = [];
  private rng = mulberry32(randomSeed());
  private acc = 0;
  private last = 0;
  private still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
  }

  resize(): void {
    this.renderer.resize(window.innerWidth, window.innerHeight);
    this.round = null;
  }

  frame(now: number): void {
    if (!this.round) this.start();
    const dt = this.last ? Math.min(250, now - this.last) : 0;
    this.last = now;
    if (!this.still) this.acc += dt;
    let stepped = false;
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      this.step();
      stepped = true;
    }
    const scene = this.scene();
    if (stepped || this.still) this.renderer.paint(scene);
    this.renderer.draw(scene, now);
  }

  private scene(): Scene {
    return { board: this.round!.board, looks: this.looks, me: -1, names: false };
  }

  private start(): void {
    const w = Math.max(24, Math.floor(window.innerWidth / CELL));
    const h = Math.max(18, Math.floor(window.innerHeight / CELL));
    const slots = Array.from({ length: PLAYERS }, (_, i) => i);
    this.round = new Round(this.rng, { w, h, slots, ticks: 1200, countdown: 0 });
    this.brains = slots.map((i) => newBrain(LEVELS[i]));
    const colors = shuffle(this.rng, [...PLAYER_COLORS]);
    this.looks = slots.map((i) => ({ color: colors[i], name: "" }));
    // Start with some land already taken, so the screen never opens empty.
    for (let i = 0; i < 150; i++) this.step();
  }

  private step(): void {
    const round = this.round!;
    for (let s = 0; s < PLAYERS; s++) {
      if (round.board.heads[s].alive) round.steer(s, think(round, s, this.brains[s], this.rng));
    }
    round.step();
    if (round.over) this.round = null;
    if (!this.round) this.start();
  }
}
