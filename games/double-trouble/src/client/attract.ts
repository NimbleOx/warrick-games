import { mulberry32, randomSeed } from "@warrick/kit/shared/rng";
import { choose, cpuPace, type CpuLevel } from "../shared/ai";
import { Lane } from "../shared/engine";
import { boardUnits, drawTile } from "./render";

const LEVELS: CpuLevel[] = ["hard", "normal", "easy", "hard", "normal", "normal", "hard", "easy"];
const SIZE = 4;
const GAP = 0.12;

interface Demo {
  lane: Lane;
  level: CpuLevel;
  next: number;
  /** Moved since it was last drawn. */
  dirty: boolean;
}

/**
 * The home screen's backdrop: a row of CPUs playing a real battle with the same engine and AI
 * the server uses, rocks and all. Each board moves a couple of times a second and nothing on it
 * animates, and the home card blurs whatever is under it: so a frame draws only the boards that
 * moved since the last one, and nothing at all most of the time.
 */
export class Attract {
  private ctx: CanvasRenderingContext2D;
  private demos: Demo[] = [];
  private rng = mulberry32(randomSeed());
  private u = 36;
  private dpr = 1;
  private garbageId = 0;
  private still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  /** Draw every board on the next frame: after a resize, a lost context or a font arriving. */
  private all = true;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("contextrestored", () => (this.all = true));
    // Tile numbers are drawn in a web font: draw them again once it's in.
    document.fonts?.addEventListener("loadingdone", () => (this.all = true));
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.all = true;
    this.u = Math.max(24, Math.min(54, Math.floor(h / 10)));
    const count = Math.max(2, Math.min(7, Math.floor(w / (boardUnits(SIZE) * this.u * 1.3))));
    if (count !== this.demos.length) {
      this.demos = Array.from({ length: count }, (_, i) => this.fresh(LEVELS[i % LEVELS.length], 0));
      // Open on boards with something on them already.
      for (const d of this.demos) for (let i = 0; i < 40 + Math.floor(this.rng() * 80); i++) this.step(d);
    }
  }

  frame(now: number): void {
    if (!this.demos.length) this.resize();
    const { ctx, u } = this;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const all = this.all;
    this.all = false;
    if (all) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
    }
    const n = this.demos.length;
    const bw = boardUnits(SIZE) * u;
    const gap = (w - n * bw) / (n + 1);
    this.demos.forEach((d, i) => {
      // A move changes only the board that made it: rocks it sends wait in the other's queue.
      if (!this.still && now >= d.next) {
        if (!d.next) d.next = now;
        this.step(d);
        d.next = now + cpuPace(d.level, this.rng) * 1.3;
        d.dirty = true;
      }
      if (!all && !d.dirty) return;
      d.dirty = false;
      const x0 = Math.round(gap + i * (bw + gap));
      // Stagger the boards up and down a little.
      const y0 = Math.round((h - bw) / 2 + (i % 2 ? 1 : -1) * u * 0.9);
      if (!all) ctx.clearRect(x0 - 1, y0 - 1, bw + 2, bw + 2);
      ctx.fillStyle = "rgb(14 17 34 / 0.85)";
      ctx.beginPath();
      ctx.roundRect(x0, y0, bw, bw, u * 0.12);
      ctx.fill();
      const cells = d.lane.board.cells;
      for (let c = 0; c < cells.length; c++) {
        const x = x0 + GAP * u + (c % SIZE) * (1 + GAP) * u;
        const y = y0 + GAP * u + Math.floor(c / SIZE) * (1 + GAP) * u;
        if (cells[c]) drawTile(ctx, x, y, u, cells[c], u >= 30, c);
        else {
          ctx.fillStyle = "#171c34";
          ctx.fillRect(x, y, u, u);
        }
      }
    });
  }

  private fresh(level: CpuLevel, next: number): Demo {
    return { lane: new Lane(randomSeed(), SIZE), level, next, dirty: true };
  }

  private step(d: Demo): void {
    const dir = choose(d.lane, d.level, this.rng);
    const res = dir === null ? null : d.lane.move(dir, this.garbageId);
    if (res?.sent) {
      const others = this.demos.filter((o) => o !== d);
      const to = others[Math.floor(this.rng() * others.length)];
      to?.lane.queue.push({ id: ++this.garbageId, rocks: res.sent, from: 0, at: -1 });
    }
    if (!res || d.lane.out) Object.assign(d, this.fresh(d.level, d.next));
  }
}
