import { choose, type CpuLevel } from "../shared/ai";
import { COLS, SPAWN_Y, VISIBLE } from "../shared/constants";
import { Lane, type Placement } from "../shared/engine";
import { SHAPES } from "../shared/pieces";
import { mulberry32, randomSeed } from "@warrick/kit/shared/rng";
import { PIECE_COLORS } from "./render";

const LEVELS: CpuLevel[] = ["hard", "normal", "easy", "hard", "normal", "normal", "hard", "easy"];

interface Demo {
  lane: Lane;
  level: CpuLevel;
  plan: Placement | null;
  t0: number;
  dur: number;
}

/**
 * The home screen's backdrop: a row of CPUs playing a real battle with the same engine and
 * AI the server uses, garbage and all.
 */
export class Attract {
  private ctx: CanvasRenderingContext2D;
  private demos: Demo[] = [];
  private rng = mulberry32(randomSeed());
  private cell = 16;
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
    this.cell = Math.max(10, Math.min(22, Math.floor(h / 26)));
    const count = Math.max(2, Math.min(8, Math.floor(w / (this.cell * 13))));
    if (count !== this.demos.length) {
      this.demos = Array.from({ length: count }, (_, i) => this.fresh(LEVELS[i % LEVELS.length]));
      // Open on boards with something on them already.
      for (const d of this.demos) for (let i = 0; i < 12 + Math.floor(this.rng() * 20); i++) this.place(d);
    }
  }

  frame(now: number): void {
    if (!this.demos.length) this.resize();
    const { ctx, cell: c } = this;
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    const n = this.demos.length;
    const gap = (w - n * COLS * c) / (n + 1);
    const top = Math.round((h - VISIBLE * c) / 2);
    this.demos.forEach((d, i) => {
      if (!this.still) this.advance(d, now);
      const x0 = Math.round(gap + i * (COLS * c + gap));
      ctx.fillStyle = "rgb(14 17 34 / 0.85)";
      ctx.fillRect(x0, top, COLS * c, VISIBLE * c);
      const b = d.lane.board;
      for (let y = 0; y < Math.min(b.height(), VISIBLE); y++) {
        for (let x = 0; x < COLS; x++) {
          const v = b.get(x, y);
          if (v) this.block(x0 + x * c, top + (VISIBLE - 1 - y) * c, PIECE_COLORS[v]);
        }
      }
      const p = d.plan;
      if (p && !this.still) {
        const t = Math.min(1, (now - d.t0) / d.dur);
        const y = Math.round(SPAWN_Y - 1 - (SPAWN_Y - 1 - p.y) * t * t);
        for (const [dx, dy] of SHAPES[p.piece][p.r]) {
          const row = y - dy;
          if (row < VISIBLE) this.block(x0 + (p.x + dx) * c, top + (VISIBLE - 1 - row) * c, PIECE_COLORS[p.piece]);
        }
      }
    });
  }

  private block(x: number, y: number, color: string): void {
    const { ctx, cell: c } = this;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, c, c);
    ctx.fillStyle = "rgb(0 0 0 / 0.3)";
    ctx.fillRect(x, y + c - 2, c, 2);
    ctx.fillRect(x + c - 2, y, 2, c);
  }

  private fresh(level: CpuLevel): Demo {
    return { lane: new Lane(randomSeed()), level, plan: null, t0: 0, dur: 0 };
  }

  private advance(d: Demo, now: number): void {
    if (!d.plan) {
      d.plan = choose(d.lane, d.level, this.rng, this.garbageId);
      d.t0 = now;
      d.dur = (d.level === "hard" ? 260 : d.level === "normal" ? 420 : 650) * (0.8 + this.rng() * 0.4);
      if (!d.plan) Object.assign(d, this.fresh(d.level));
      return;
    }
    if (now - d.t0 >= d.dur) this.place(d);
  }

  private place(d: Demo): void {
    const pl = d.plan ?? choose(d.lane, d.level, this.rng, this.garbageId);
    d.plan = null;
    const res = pl && d.lane.lock(pl, this.garbageId);
    if (res && res.sent) {
      const others = this.demos.filter((o) => o !== d);
      const to = others[Math.floor(this.rng() * others.length)];
      to?.lane.queue.push({ id: ++this.garbageId, lines: res.sent, hole: Math.floor(this.rng() * COLS), from: 0 });
    }
    if (!res || d.lane.out) Object.assign(d, this.fresh(d.level));
  }
}
