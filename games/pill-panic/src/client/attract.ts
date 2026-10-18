import { newBrain, think, type Brain } from "../shared/ai";
import { Bottle } from "../shared/bottle";
import { COLS, START_SPEED, TICK_MS } from "../shared/constants";
import { randomSeed } from "../shared/rng";
import { bottleSize, paintBottle } from "./render";

/** The home screen's backdrop: two CPUs racing to clear their bottles. */
export class Attract {
  private ctx: CanvasRenderingContext2D;
  private pair: { b: Bottle; brain: Brain }[] = [];
  private last = 0;
  private restartAt = 0;
  private attacks = 0;
  private w = 0;
  private h = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.reset();
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.canvas.clientWidth || window.innerWidth;
    this.h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  frame(now: number): void {
    if (!this.last) this.last = now;
    const ticks = Math.min(30, Math.floor((now - this.last) / TICK_MS));
    this.last += ticks * TICK_MS;
    for (let i = 0; i < ticks; i++) {
      this.pair.forEach(({ b, brain }, k) => {
        if (!b.done) b.step(think(b, brain));
        for (const e of b.events) {
          if (e.k !== "attack") continue;
          // Junk lands evenly spaced from a random column, like in a real game.
          const gap = e.colors.length === 2 ? 4 : e.colors.length === 3 ? 3 : 2;
          const first = Math.floor(Math.random() * (COLS - gap * (e.colors.length - 1)));
          this.pair[1 - k].b.addGarbage({ id: ++this.attacks, p: e.colors.map((c, j) => [first + j * gap, c]) });
        }
        b.events = [];
      });
    }
    if (!this.restartAt && this.pair.some(({ b }) => b.done)) this.restartAt = now + 2500;
    if (this.restartAt && now > this.restartAt) this.reset();
    this.draw(now);
  }

  private reset(): void {
    const seed = randomSeed();
    this.pair = ["normal", "hard"].map((level, i) => ({
      b: Bottle.create(seed, 6, START_SPEED.hi),
      brain: newBrain(level as "normal" | "hard", seed + i),
    }));
    this.restartAt = 0;
  }

  private draw(now: number): void {
    const { ctx, w, h } = this;
    ctx.fillStyle = "#0b0d17";
    ctx.fillRect(0, 0, w, h);
    const cell = Math.max(10, Math.min(34, Math.floor((h * 0.9) / 21)));
    const size = bottleSize(cell, true);
    const gap = Math.max(size.w * 0.3, (w - size.w * 2) / 3);
    const y = (h - size.h) / 2;
    const xs = w > size.w * 3.2 ? [w / 2 - size.w * 1.6 - 160, w / 2 + size.w * 0.6 + 160] : [gap, w - gap - size.w];
    ctx.globalAlpha = 0.55;
    this.pair.forEach(({ b }, i) => {
      paintBottle(ctx, Math.max(8, Math.min(w - size.w - 8, xs[i])), y, cell, b, {
        time: now,
        ghost: false,
        next: true,
        incoming: [],
        accent: i ? "#4da6ff" : "#ff6b8b",
        dim: b.phase === "dead",
      });
    });
    ctx.globalAlpha = 1;
  }
}
