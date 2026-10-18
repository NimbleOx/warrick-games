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
}

/**
 * The home screen's backdrop: a row of CPUs playing a real battle with the same engine and AI
 * the server uses, rocks and all.
 */
export class Attract {
  private ctx: CanvasRenderingContext2D;
  private demos: Demo[] = [];
  private rng = mulberry32(randomSeed());
  private u = 36;
  private garbageId = 0;
  private still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    ctx.clearRect(0, 0, w, h);
    const n = this.demos.length;
    const bw = boardUnits(SIZE) * u;
    const gap = (w - n * bw) / (n + 1);
    this.demos.forEach((d, i) => {
      if (!this.still && now >= d.next) {
        if (!d.next) d.next = now;
        this.step(d);
        d.next = now + cpuPace(d.level, this.rng) * 1.3;
      }
      const x0 = Math.round(gap + i * (bw + gap));
      // Stagger the boards up and down a little.
      const y0 = Math.round((h - bw) / 2 + (i % 2 ? 1 : -1) * u * 0.9);
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
    return { lane: new Lane(randomSeed(), SIZE), level, next };
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
