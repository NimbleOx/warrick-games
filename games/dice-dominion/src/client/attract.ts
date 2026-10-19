import { DEFAULT_COLORS } from "@warrick/kit/shared/constants";
import { mulberry32, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { cpuAttack } from "../shared/ai";
import type { HexMap } from "../shared/map";
import { generateMap } from "../shared/map";
import { applyAttack, largestGroup, reinforce, rollDice, setupBoard, winnerSeat } from "../shared/rules";
import { MapView, type Board, type Overlay } from "./render";

const SEATS = 5;
const STEP_MS = 420;
/** The gap between frames of a fading flash: every 2nd frame at 60 Hz, every 4th at 120 Hz. */
const FADE_MS = 30;

/** A self-playing game between CPUs behind the home screen. */
export class Attract {
  private view: MapView;
  private rng: Rng = mulberry32(randomSeed());
  private map!: HexMap;
  private board!: Board;
  private reserve: number[] = [];
  private turn = 0;
  private nextAt = 0;
  private resetAt = 0;
  /** Something changed since the last draw. */
  private dirty = true;
  private drawnAt = 0;
  private overlay: Overlay = {
    colors: [0, 2, 4, 6, 1].map((i) => DEFAULT_COLORS[i]),
    selected: -1,
    targets: new Map(),
    hover: -1,
    attack: null,
    flash: new Map(),
    active: -1,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.view = new MapView(canvas, true);
    canvas.addEventListener("contextrestored", () => (this.dirty = true));
    this.reset();
  }

  resize(): void {
    this.view.resize(window.innerWidth, window.innerHeight);
    this.dirty = true;
  }

  /**
   * Called every animation frame, but the board only changes a couple of times a second, and
   * the home card blurs whatever is under it: so draw only when something changed. Nearly every
   * step lights something up, so fades draw at about 30 frames a second, not the display's rate.
   */
  frame(now: number): void {
    if (this.resetAt && now > this.resetAt) this.reset();
    else if (!this.resetAt && now > this.nextAt) this.step(now);
    let fading = false;
    for (const [t, at] of this.overlay.flash) {
      if (now - at < 400) fading = true;
      else {
        this.overlay.flash.delete(t);
        this.dirty = true; // one more frame without it
      }
    }
    if (!this.dirty && !(fading && now - this.drawnAt >= FADE_MS)) return;
    this.dirty = false;
    this.drawnAt = now;
    this.view.draw(this.board, this.overlay, now);
  }

  private reset(): void {
    this.map = generateMap(randomSeed(), SEATS * 6);
    this.view.setMap(this.map);
    this.board = setupBoard(this.rng, this.map.adj.length, SEATS, 12);
    this.reserve = new Array(SEATS).fill(0);
    this.turn = 0;
    this.resetAt = 0;
    this.overlay.attack = null;
    this.nextAt = performance.now() + 800;
    this.resize();
  }

  private step(now: number): void {
    const { owner, dice } = this.board;
    const seat = this.turn % SEATS;
    this.nextAt = now + STEP_MS;
    if (!owner.includes(seat)) {
      this.turn++;
      return;
    }
    this.dirty = true;
    const move = cpuAttack("normal", { adj: this.map.adj, owner, dice }, seat, this.rng);
    if (!move) {
      const r = reinforce(this.rng, owner, dice, seat, largestGroup(this.map.adj, owner, seat), this.reserve[seat]);
      this.reserve[seat] = r.reserve;
      for (const t of r.placed) this.overlay.flash.set(t, now);
      this.overlay.attack = null;
      this.turn++;
      return;
    }
    const [from, to] = move;
    const won = applyAttack(owner, dice, from, to, rollDice(this.rng, dice[from]), rollDice(this.rng, dice[to]));
    this.overlay.attack = { from, to, won };
    if (won) this.overlay.flash.set(to, now);
    if (winnerSeat(owner) !== null) this.resetAt = now + 2500;
  }
}
