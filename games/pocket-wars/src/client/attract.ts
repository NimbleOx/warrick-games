import { DEFAULT_COLORS } from "@warrick/kit/shared/constants";
import { mulberry32, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { seatFunds } from "../shared/constants";
import { cpuNext } from "../shared/ai";
import { MAPS, type MapDef } from "../shared/maps";
import { actProblem, applyAct, applyBuild, buildProblem, endTurn, newBoard, startTurn, unitTile, winnerSeat, type Board } from "../shared/rules";
import { Renderer } from "./render";

const DEMO_MAPS = ["twin-rivers", "mirror-lake", "four-corners"];
const STEP_MS = 420;

/** Behind the home screen: CPUs playing each other with the real rules. */
export class Attract {
  private renderer: Renderer;
  private rng: Rng = mulberry32(randomSeed());
  private m!: MapDef;
  private b!: Board;
  private seat = 0;
  private day = 1;
  private nextAt = 0;
  private colors: string[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.reset();
  }

  private reset(): void {
    this.m = MAPS[DEMO_MAPS[Math.floor(this.rng() * DEMO_MAPS.length)]];
    this.b = newBoard(this.m, seatFunds(this.m.players));
    // Give everyone a head start so there's something to watch straight away.
    for (let s = 0; s < this.m.players; s++) this.b.funds[s] += 6000;
    this.seat = 0;
    this.day = 1;
    const start = Math.floor(this.rng() * DEFAULT_COLORS.length);
    this.colors = Array.from({ length: this.m.players }, (_, i) => DEFAULT_COLORS[(start + i * 2) % DEFAULT_COLORS.length]);
    startTurn(this.m, this.b, 0);
    this.cover();
  }

  resize(): void {
    this.renderer.resize(window.innerWidth, window.innerHeight);
    this.cover();
  }

  /** Fill the screen with the map, like object-fit: cover. */
  private cover(): void {
    const r = this.renderer;
    const m = this.m;
    r.scale = Math.max(r.w / m.w, r.h / m.h);
    r.ox = (r.w - m.w * r.scale) / 2;
    r.oy = (r.h - m.h * r.scale) / 2;
  }

  frame(now: number): void {
    if (now >= this.nextAt) {
      this.nextAt = now + STEP_MS;
      this.step();
    }
    this.renderer.draw({ m: this.m, b: this.b, colors: this.colors, activeSeat: this.seat }, now);
  }

  private step(): void {
    const { m, b } = this;
    if (winnerSeat(b) !== null || this.day > 30) return this.reset();
    const mv = cpuNext("normal", m, b, this.seat, this.rng, this.day);
    if (mv.kind === "act" && !actProblem(m, b, this.seat, mv.act)) {
      const ev = applyAct(m, b, this.seat, mv.act);
      if (ev.action === "attack") {
        const t = b.units.find((u) => u.id === ev.target);
        const tile = t ? unitTile(m, t) : ev.path[ev.path.length - 1];
        this.renderer.flash(m, tile);
        if (ev.killed) this.renderer.boom(m, tile);
      }
      return;
    }
    if (mv.kind === "build" && !buildProblem(m, b, this.seat, mv.at, mv.unit)) {
      applyBuild(m, b, this.seat, mv.at, mv.unit);
      return;
    }
    // End of this CPU's turn.
    endTurn(b, this.seat);
    for (let i = 1; i <= m.players; i++) {
      const next = (this.seat + i) % m.players;
      if (b.out[next]) continue;
      if (this.seat + i >= m.players) this.day++;
      this.seat = next;
      break;
    }
    startTurn(m, b, this.seat);
  }
}
