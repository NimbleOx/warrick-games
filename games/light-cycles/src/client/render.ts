import type { Arena, Cycle, Dir, Frame } from "../shared/arena";
import { DX, DY } from "../shared/arena";
import { rgba } from "@warrick/kit/client/color";
import { THEMES, lighten, type Theme } from "./themes";

export interface RiderInfo {
  name: string;
  color: string;
  you: boolean;
}

export interface DrawOpts {
  theme: number;
  riders: Map<string, RiderInfo>;
  /** Names and headings over each cycle (during the countdown). */
  labels: boolean;
  tickMs: number;
  /** In the countdown, the turn you've asked for: your heading chevrons show it. */
  turn?: Dir | null;
  /** Your cycle run on ahead of the frames (see `Predictor`), drawn in place of the arena's. */
  ahead?: { i: number; cycle: Cycle; head: [number, number] } | null;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  born: number;
  life: number;
  size: number;
}

interface Ring {
  x: number;
  y: number;
  color: string;
  born: number;
}

const DEREZ_MS = 900;
const RING_MS = 650;

/**
 * Draws an Arena onto a canvas. Everything is in cell units (cell centers at
 * x + 0.5); the arena only changes once per tick, so heads are interpolated
 * from where they were before the latest frame.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private floor = document.createElement("canvas");
  private floorKey = "";
  private dpr = 1;
  /** Canvas pixels per CSS pixel of layout, so labels stay readable at any size. */
  private ui = 1;
  private prev = new Map<number, [number, number]>();
  private frameAt = 0;
  /** When each crashed cycle went down; its wall flickers out for DEREZ_MS. */
  private derez = new Map<number, number>();
  private sparks: Spark[] = [];
  private rings: Ring[] = [];
  private shake = 0;
  private flash = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  resize(cssWidth: number): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(200, Math.round(cssWidth * this.dpr));
    const h = Math.round((w * 9) / 16);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ui = this.dpr * Math.min(1.25, Math.max(0.85, cssWidth / 900));
  }

  /** A new arena is about to be shown: forget the old one's effects. Cycles already down stay gone. */
  reset(arena: Arena): void {
    this.prev.clear();
    this.derez.clear();
    this.sparks = [];
    this.rings = [];
    arena.cycles.forEach((c, i) => {
      if (!c.alive) this.derez.set(i, -Infinity);
    });
  }

  /** Call just before applying a frame, so heads can glide from where they were. */
  beforeFrame(arena: Arena, now: number): void {
    this.prev.clear();
    arena.cycles.forEach((c, i) => {
      if (c.alive) this.prev.set(i, [c.x, c.y]);
    });
    this.frameAt = now;
  }

  /** Visual reactions to what happened in a frame (call after applying it). */
  afterFrame(arena: Arena, f: Frame, now: number, colorOf: (id: string) => string, youId?: string): void {
    for (const ev of f.e) {
      if (ev.k === "crash") {
        const c = arena.cycles[ev.i];
        const color = colorOf(c.id);
        this.derez.set(ev.i, now);
        this.rings.push({ x: ev.x + 0.5, y: ev.y + 0.5, color, born: now });
        this.burst(ev.x + 0.5, ev.y + 0.5, color, 26, 0.03, now);
        // The wall shatters too: sparks along its length.
        const pts = trailPoints(c, 2.5, 90);
        for (let k = 0; k < pts.length; k += 2) this.burst(pts[k], pts[k + 1], color, 1, 0.008, now);
        this.shake = Math.max(this.shake, c.id === youId ? 10 : 4);
        if (c.id === youId) this.flash = 0.35;
      } else if (ev.k === "boost") {
        const c = arena.cycles[ev.i];
        this.burst(c.x + 0.5, c.y + 0.5, colorOf(c.id), 10, 0.015, now);
      }
    }
  }

  draw(arena: Arena, opts: DrawOpts, now: number): void {
    const ctx = this.ctx;
    const theme = THEMES[opts.theme % THEMES.length];
    const { w, h } = arena.cfg;
    const k = this.canvas.width / w;
    const key = `${this.canvas.width}x${this.canvas.height}:${w}x${h}:${opts.theme}`;
    if (key !== this.floorKey) this.renderFloor(theme, w, h, key);

    let ox = 0;
    let oy = 0;
    if (this.shake > 0.3) {
      ox = (Math.random() - 0.5) * this.shake * this.dpr;
      oy = (Math.random() - 0.5) * this.shake * this.dpr;
      this.shake *= 0.86;
    } else {
      this.shake = 0;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(this.floor, ox, oy);
    ctx.setTransform(k, 0, 0, k, ox, oy);

    if (arena.shrink > 0) this.drawClosingWall(arena, now);

    const alpha = opts.tickMs > 0 ? Math.min(1, Math.max(0, (now - this.frameAt) / opts.tickMs)) : 1;
    const ahead = opts.ahead ?? null;
    // Your cycle, while it's riding on screen, is drawn as predicted.
    const shown = (c: Cycle, i: number) => (c.alive && ahead?.i === i ? ahead.cycle : c);
    const heads = arena.cycles.map((c, i) => (c.alive && ahead?.i === i ? ahead.head : this.headAt(c, i, alpha)));

    // Walls of crashed cycles flicker out.
    ctx.globalCompositeOperation = "lighter";
    arena.cycles.forEach((c, i) => {
      if (c.alive) return;
      const t = (now - (this.derez.get(i) ?? -Infinity)) / DEREZ_MS;
      if (t >= 1) return;
      const flicker = Math.random() < 0.25 ? 0.25 : 1;
      this.drawWall(c.trail, null, opts.riders.get(c.id)?.color ?? "#ffffff", (1 - t) * flicker);
    });
    arena.cycles.forEach((c, i) => {
      if (c.alive) this.drawWall(shown(c, i).trail, heads[i], opts.riders.get(c.id)?.color ?? "#ffffff", 1);
    });
    ctx.globalCompositeOperation = "source-over";

    arena.cycles.forEach((c, i) => {
      if (c.alive) this.drawCycle(shown(c, i), heads[i], opts.riders.get(c.id), now);
    });
    this.drawEffects(now);
    if (opts.labels) {
      const turn = opts.turn ?? null;
      arena.cycles.forEach((c, i) => {
        if (!c.alive) return;
        const info = opts.riders.get(c.id);
        // During the countdown your heading chevrons show the line you've picked.
        this.drawLabel(info?.you && turn !== null ? turn : c.dir, heads[i], info, k, now);
      });
    }

    if (this.flash > 0.01) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(255, 255, 255, ${this.flash})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.flash *= 0.85;
    }
  }

  // ---------------------------------------------------------------- floor

  private renderFloor(theme: Theme, w: number, h: number, key: string): void {
    const c = this.floor;
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext("2d")!;
    const k = c.width / w;

    const bg = g.createRadialGradient(c.width / 2, c.height / 2, 0, c.width / 2, c.height / 2, c.width * 0.62);
    bg.addColorStop(0, theme.floor);
    bg.addColorStop(1, theme.edge);
    g.fillStyle = bg;
    g.fillRect(0, 0, c.width, c.height);

    // Fine lines every cell (when they're big enough to see), brighter ones every 8.
    const line = Math.max(1, Math.round(this.dpr * 0.6));
    if (k >= 6) {
      g.fillStyle = rgba(theme.grid, 0.07);
      for (let x = 1; x < w; x++) g.fillRect(Math.round(x * k), 0, line, c.height);
      for (let y = 1; y < h; y++) g.fillRect(0, Math.round(y * k), c.width, line);
    }
    g.fillStyle = rgba(theme.grid, 0.2);
    for (let x = 8; x < w; x += 8) g.fillRect(Math.round(x * k), 0, line, c.height);
    for (let y = 8; y < h; y += 8) g.fillRect(0, Math.round(y * k), c.width, line);

    // Glowing arena wall.
    g.strokeStyle = rgba(theme.grid, 0.25);
    g.lineWidth = 6 * this.dpr;
    g.strokeRect(0, 0, c.width, c.height);
    g.strokeStyle = rgba(theme.grid, 0.9);
    g.lineWidth = 2 * this.dpr;
    g.strokeRect(this.dpr, this.dpr, c.width - 2 * this.dpr, c.height - 2 * this.dpr);
    this.floorKey = key;
  }

  private drawClosingWall(arena: Arena, now: number): void {
    const ctx = this.ctx;
    const s = arena.shrink;
    const { w, h } = arena.cfg;
    ctx.fillStyle = "rgba(60, 4, 12, 0.72)";
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.rect(s, s, w - 2 * s, h - 2 * s);
    ctx.fill("evenodd");
    const pulse = 0.65 + 0.35 * Math.sin(now / 120);
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `rgba(255, 50, 70, ${0.25 * pulse})`;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(s, s, w - 2 * s, h - 2 * s);
    ctx.strokeStyle = `rgba(255, 120, 130, ${pulse})`;
    ctx.lineWidth = 0.3;
    ctx.strokeRect(s, s, w - 2 * s, h - 2 * s);
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------------------------------------------------------------- cycles

  /** Where to draw a head this frame, in cell-center coordinates. */
  private headAt(c: Cycle, i: number, alpha: number): [number, number] {
    const p = this.prev.get(i);
    if (!c.alive || !p || alpha >= 1) return [c.x + 0.5, c.y + 0.5];
    if (Math.abs(c.x - p[0]) + Math.abs(c.y - p[1]) > 2) return [c.x + 0.5, c.y + 0.5]; // wrapped
    return [p[0] + (c.x - p[0]) * alpha + 0.5, p[1] + (c.y - p[1]) * alpha + 0.5];
  }

  private drawWall(trail: number[][], head: [number, number] | null, color: string, alpha: number): void {
    if (alpha <= 0) return;
    const ctx = this.ctx;
    const path = new Path2D();
    trail.forEach((line, li) => {
      const last = li === trail.length - 1;
      for (let k = 0; k < line.length; k += 2) {
        let x = line[k] + 0.5;
        let y = line[k + 1] + 0.5;
        if (head && last && k === line.length - 2) [x, y] = head;
        if (k === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      if (line.length === 2) path.lineTo(line[0] + 0.5001, line[1] + 0.5);
    });
    ctx.lineJoin = "miter";
    ctx.lineCap = "square";
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = rgba(color, 0.16);
    ctx.lineWidth = 1.25;
    ctx.stroke(path);
    ctx.strokeStyle = rgba(color, 0.85);
    ctx.lineWidth = 0.42;
    ctx.stroke(path);
    ctx.strokeStyle = lighten(color, 0.65);
    ctx.lineWidth = 0.14;
    ctx.stroke(path);
    ctx.globalAlpha = 1;
  }

  private drawCycle(c: Cycle, head: [number, number], info: RiderInfo | undefined, now: number): void {
    const ctx = this.ctx;
    const color = info?.color ?? "#ffffff";
    const [x, y] = head;
    const dx = DX[c.dir];
    const dy = DY[c.dir];
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(dy, dx));

    if (c.boost > 0) {
      // Afterburner streak.
      const g = ctx.createLinearGradient(-4, 0, 0, 0);
      g.addColorStop(0, rgba(color, 0));
      g.addColorStop(1, rgba(color, 0.9));
      ctx.fillStyle = g;
      ctx.fillRect(-4, -0.45, 4, 0.9);
    }

    ctx.shadowColor = color;
    ctx.shadowBlur = 12 * this.dpr;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(-0.9, -0.42, 1.65, 0.84, 0.3);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = lighten(color, 0.8);
    ctx.beginPath();
    ctx.roundRect(-0.35, -0.2, 0.95, 0.4, 0.15);
    ctx.fill();
    ctx.restore();

    if (info?.you) {
      const r = 1.6 + Math.sin(now / 200) * 0.25;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
      ctx.lineWidth = 0.12;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawLabel(dir: Dir, head: [number, number], info: RiderInfo | undefined, k: number, now: number): void {
    if (!info) return;
    const ctx = this.ctx;
    const [x, y] = head;

    // Heading chevrons in front of the cycle.
    ctx.fillStyle = rgba(info.color, 0.85);
    for (let n = 0; n < 3; n++) {
      const a = 0.35 + 0.65 * (((now / 140 - n) % 3) / 3);
      ctx.globalAlpha = a;
      ctx.save();
      ctx.translate(x + DX[dir] * (1.8 + n * 0.9), y + DY[dir] * (1.8 + n * 0.9));
      ctx.rotate(Math.atan2(DY[dir], DX[dir]));
      ctx.beginPath();
      ctx.moveTo(0.35, 0);
      ctx.lineTo(-0.3, -0.45);
      ctx.lineTo(-0.3, 0.45);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const u = this.ui;
    const text = info.you ? `${info.name} (you)` : info.name;
    ctx.font = `600 ${12 * u}px "IBM Plex Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const px = Math.min(this.canvas.width - 60 * u, Math.max(60 * u, x * k));
    const above = y * k > 40 * u && dir !== 0;
    const py = above ? y * k - 14 * u : y * k + 28 * u;
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    ctx.strokeText(text, px, py);
    ctx.fillStyle = info.you ? "#ffffff" : lighten(info.color, 0.3);
    ctx.fillText(text, px, py);
    ctx.restore();
  }

  // ---------------------------------------------------------------- effects

  private burst(x: number, y: number, color: string, n: number, speed: number, now: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random());
      this.sparks.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        color,
        born: now,
        life: 500 + Math.random() * 700,
        size: 0.18 + Math.random() * 0.32,
      });
    }
  }

  private drawEffects(now: number): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "lighter";
    this.rings = this.rings.filter((r) => now - r.born < RING_MS);
    for (const r of this.rings) {
      const t = (now - r.born) / RING_MS;
      ctx.strokeStyle = rgba(r.color, 1 - t);
      ctx.lineWidth = 0.35 * (1 - t) + 0.05;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 0.5 + t * 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    this.sparks = this.sparks.filter((s) => now - s.born < s.life);
    for (const s of this.sparks) {
      const age = now - s.born;
      const t = age / s.life;
      ctx.fillStyle = rgba(s.color, 1 - t);
      const x = s.x + s.vx * age;
      const y = s.y + s.vy * age;
      ctx.fillRect(x - s.size / 2, y - s.size / 2, s.size, s.size);
    }
    ctx.globalCompositeOperation = "source-over";
  }
}

/** Points spaced roughly `step` cells apart along a cycle's wall (at most `max`), for derez sparks. */
function trailPoints(c: Cycle, step: number, max: number): number[] {
  const out: number[] = [];
  for (const line of c.trail) {
    for (let k = 0; k + 2 < line.length; k += 2) {
      const x0 = line[k];
      const y0 = line[k + 1];
      const len = Math.abs(line[k + 2] - x0) + Math.abs(line[k + 3] - y0);
      for (let d = 0; d < len; d += step) {
        out.push(x0 + Math.sign(line[k + 2] - x0) * d + 0.5, y0 + Math.sign(line[k + 3] - y0) * d + 0.5);
      }
    }
  }
  if (out.length / 2 <= max) return out;
  const thin: number[] = [];
  const every = Math.ceil(out.length / 2 / max);
  for (let k = 0; k < out.length; k += 2 * every) thin.push(out[k], out[k + 1]);
  return thin;
}
