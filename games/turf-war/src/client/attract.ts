import { newBrain, think, type Brain, type CpuLevel } from "../shared/ai";
import { PLAYER_COLORS, TICK_MS } from "../shared/constants";
import { mulberry32, randomSeed, shuffle } from "@warrick/kit/shared/rng";
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
  /** Something changed since the last draw. */
  private dirty = true;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    canvas.addEventListener("contextrestored", () => (this.dirty = true));
  }

  resize(): void {
    this.renderer.resize(window.innerWidth, window.innerHeight);
    // A new round only when the board would be a different size: setting one up runs 150 ticks.
    const [w, h] = gridSize();
    const b = this.round?.board;
    if (b && (b.w !== w || b.h !== h)) this.round = null;
    this.dirty = true;
  }

  /**
   * Called every animation frame, but the board only changes on a tick (10 a second), and the
   * home card blurs whatever is under it: so draw only when something changed. Nothing in it
   * fades or glides, so between changes it draws nothing at all.
   */
  frame(now: number): void {
    if (!this.round) this.start();
    const dt = this.last ? Math.min(250, now - this.last) : 0;
    this.last = now;
    if (!this.still) this.acc += dt;
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      this.step();
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const scene = this.scene();
    this.renderer.paint(scene);
    this.renderer.draw(scene, now);
  }

  private scene(): Scene {
    return { board: this.round!.board, looks: this.looks, me: -1, names: false };
  }

  private start(): void {
    const [w, h] = gridSize();
    const slots = Array.from({ length: PLAYERS }, (_, i) => i);
    this.round = new Round(this.rng, { w, h, slots, ticks: 1200, countdown: 0 });
    this.brains = slots.map((i) => newBrain(LEVELS[i]));
    const colors = shuffle(this.rng, [...PLAYER_COLORS]);
    this.looks = slots.map((i) => ({ color: colors[i], name: "" }));
    // Start with some land already taken, so the screen never opens empty.
    for (let i = 0; i < 150; i++) this.step();
    this.dirty = true;
  }

  private step(): void {
    const round = this.round!;
    for (let s = 0; s < PLAYERS; s++) {
      if (round.board.heads[s].alive) round.steer(s, think(round, s, this.brains[s], this.rng));
    }
    round.step();
    if (round.over) this.start();
  }
}

/** The board's size in cells for the window: one cell every 16 CSS px. */
function gridSize(): [number, number] {
  return [Math.max(24, Math.floor(window.innerWidth / CELL)), Math.max(18, Math.floor(window.innerHeight / CELL))];
}
