import { DEFAULT_COLORS } from "@warrick/kit/shared/constants";
import { mulberry32, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { cpuAttack } from "../shared/ai";
import type { HexMap } from "../shared/map";
import { generateMap } from "../shared/map";
import { applyAttack, largestGroup, reinforce, rollDice, setupBoard, winnerSeat } from "../shared/rules";
import { MapView, type Board, type Overlay } from "./render";

const SEATS = 5;
const STEP_MS = 420;

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
    this.reset();
  }

  resize(): void {
    this.view.resize(window.innerWidth, window.innerHeight);
  }

  frame(now: number): void {
    if (this.resetAt && now > this.resetAt) this.reset();
    else if (!this.resetAt && now > this.nextAt) this.step(now);
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
