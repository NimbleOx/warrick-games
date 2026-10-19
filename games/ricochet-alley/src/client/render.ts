import { shade } from "@warrick/kit/client/color";
import { BULLET_R, CELL, TANK_R } from "../shared/constants";
import { mazeHeight, mazeWidth, wallRects, type Maze, type Rect } from "../shared/maze";
import { THEMES, type Theme } from "./themes";

export interface DrawTank {
  id: string;
  x: number;
  y: number;
  /** Heading in radians. */
  a: number;
  color: string;
  name: string;
  me: boolean;
}

export interface DrawBullet {
  x: number;
  y: number;
}

export interface DrawOpts {
  tanks: DrawTank[];
  bullets: DrawBullet[];
  /** Pulse a ring round your own tank (start of a round). */
  findMe: boolean;
  /** Draw names over the tanks. */
  names: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  size: number;
  color: string;
}

interface Ring {
  x: number;
  y: number;
  born: number;
  color: string;
}

/** World units of margin around the maze, so the border walls aren't flush with the canvas edge. */
const PAD = 8;

/** Draws one maze and everything in it onto a canvas, scaled to fit. */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private maze: Maze | null = null;
  private walls: Rect[] = [];
  private theme: Theme = THEMES[0];
  private layer: HTMLCanvasElement = document.createElement("canvas");
  private scale = 1;
  private dpr = 1;
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private flashes: { x: number; y: number; born: number }[] = [];
  private scorches: { x: number; y: number; r: number }[] = [];
  private boxW = 0;
  private boxH = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  setMaze(maze: Maze, theme: number): void {
    this.maze = maze;
    this.walls = wallRects(maze);
    this.theme = THEMES[theme % THEMES.length];
    this.particles = [];
    this.rings = [];
    this.flashes = [];
    this.scorches = [];
    this.layout();
  }

  /** Fit the maze inside a box of this many CSS pixels. */
  fit(maxW: number, maxH: number): void {
    this.boxW = Math.max(100, maxW);
    this.boxH = Math.max(80, maxH);
    this.layout();
  }

  private layout(): void {
    const m = this.maze;
    if (!m || !this.boxW) return;
    const ww = mazeWidth(m) + PAD * 2;
    const wh = mazeHeight(m) + PAD * 2;
    this.scale = Math.min(this.boxW / ww, this.boxH / wh);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = Math.floor(ww * this.scale);
    const cssH = Math.floor(wh * this.scale);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.layer.width = this.canvas.width;
    this.layer.height = this.canvas.height;
    this.paintLayer();
  }

  private toWorld(ctx: CanvasRenderingContext2D): void {
    const k = this.scale * this.dpr;
    ctx.setTransform(k, 0, 0, k, PAD * k, PAD * k);
  }

  /** The static part: floor, walls and scorch marks, painted once per maze or resize. */
  private paintLayer(): void {
    const m = this.maze!;
    const t = this.theme;
    const ctx = this.layer.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = t.floor;
    ctx.fillRect(0, 0, this.layer.width, this.layer.height);
    this.toWorld(ctx);
    ctx.fillStyle = t.floor2;
    for (let r = 0; r < m.rows; r++) {
      for (let c = 0; c < m.cols; c++) if ((r + c) % 2) ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
    }
    for (const s of this.scorches) this.paintScorch(ctx, s.x, s.y, s.r);
    ctx.fillStyle = "rgb(0 0 0 / 0.25)";
    for (const w of this.walls) ctx.fillRect(w.x0 + 2, w.y0 + 3, w.x1 - w.x0, w.y1 - w.y0);
    ctx.fillStyle = t.wall;
    for (const w of this.walls) ctx.fillRect(w.x0, w.y0, w.x1 - w.x0, w.y1 - w.y0);
    ctx.fillStyle = t.wallEdge;
    for (const w of this.walls) {
      ctx.fillRect(w.x0, w.y0, w.x1 - w.x0, 1.5);
      ctx.fillRect(w.x0, w.y0, 1.5, w.y1 - w.y0);
    }
  }

  private paintScorch(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, this.theme.scorch);
    g.addColorStop(1, "rgb(0 0 0 / 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------------------------------------------------------------- effects

  explode(x: number, y: number, color: string, now: number): void {
    this.rings.push({ x, y, born: now, color });
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 160;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        born: now,
        life: 350 + Math.random() * 500,
        size: 2 + Math.random() * 4,
        color: i % 3 === 0 ? "#ffd23f" : i % 3 === 1 ? color : "#ff7424",
      });
    }
    const scorch = { x, y, r: TANK_R * 1.9 };
    this.scorches.push(scorch);
    if (this.maze) {
      const ctx = this.layer.getContext("2d")!;
      this.toWorld(ctx);
      this.paintScorch(ctx, scorch.x, scorch.y, scorch.r);
      // Walls go back on top of the scorch.
      ctx.fillStyle = this.theme.wall;
      for (const w of this.walls) {
        if (w.x1 < x - scorch.r || w.x0 > x + scorch.r || w.y1 < y - scorch.r || w.y0 > y + scorch.r) continue;
        ctx.fillRect(w.x0, w.y0, w.x1 - w.x0, w.y1 - w.y0);
        ctx.fillStyle = this.theme.wallEdge;
        ctx.fillRect(w.x0, w.y0, w.x1 - w.x0, 1.5);
        ctx.fillRect(w.x0, w.y0, 1.5, w.y1 - w.y0);
        ctx.fillStyle = this.theme.wall;
      }
    }
  }

  spark(x: number, y: number, now: number): void {
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 60;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        born: now,
        life: 120 + Math.random() * 120,
        size: 1.5,
        color: this.theme.bullet,
      });
    }
  }

  muzzle(x: number, y: number, now: number): void {
    this.flashes.push({ x, y, born: now });
  }

  // ---------------------------------------------------------------- frame

  draw(o: DrawOpts, now: number): void {
    const ctx = this.ctx;
    if (!this.maze) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.layer, 0, 0);
    this.toWorld(ctx);

    for (const t of o.tanks) this.drawTank(ctx, t);

    // Bullets
    ctx.fillStyle = this.theme.bullet;
    ctx.strokeStyle = this.theme.bulletEdge;
    ctx.lineWidth = 1.2;
    for (const b of o.bullets) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, BULLET_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Muzzle flashes
    this.flashes = this.flashes.filter((f) => now - f.born < 80);
    for (const f of this.flashes) {
      const k = 1 - (now - f.born) / 80;
      ctx.fillStyle = `rgb(255 230 140 / ${0.9 * k})`;
      ctx.beginPath();
      ctx.arc(f.x, f.y, 5 + 6 * k, 0, Math.PI * 2);
      ctx.fill();
    }

    // Explosions
    this.rings = this.rings.filter((r) => now - r.born < 500);
    for (const r of this.rings) {
      const k = (now - r.born) / 500;
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 4 * (1 - k) + 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, TANK_R * (0.6 + 2.2 * k), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.particles = this.particles.filter((p) => now - p.born < p.life);
    for (const p of this.particles) {
      const age = (now - p.born) / 1000;
      const k = 1 - (now - p.born) / p.life;
      const drag = 1 - Math.min(0.85, age * 1.6);
      ctx.globalAlpha = k;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x + p.vx * age * drag - p.size / 2, p.y + p.vy * age * drag - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // Finder ring and names are drawn last, over everything.
    const me = o.tanks.find((t) => t.me);
    if (o.findMe && me) {
      const k = (now % 900) / 900;
      ctx.strokeStyle = me.color;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(me.x, me.y, TANK_R + 6 + k * 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (o.names) this.drawNames(o.tanks);
  }

  private drawTank(ctx: CanvasRenderingContext2D, t: DrawTank): void {
    ctx.save();
    ctx.translate(t.x, t.y);
    // Shadow
    ctx.fillStyle = "rgb(0 0 0 / 0.28)";
    ctx.beginPath();
    ctx.arc(2, 3, TANK_R - 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(t.a);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = this.theme.outline;
    // Treads
    ctx.fillStyle = "#2b2f3a";
    roundRect(ctx, -15, -16, 30, 8, 2.5);
    ctx.fill();
    ctx.stroke();
    roundRect(ctx, -15, 8, 30, 8, 2.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgb(255 255 255 / 0.12)";
    for (let x = -12; x <= 12; x += 5) {
      ctx.fillRect(x, -15, 1.5, 6);
      ctx.fillRect(x, 9, 1.5, 6);
    }
    // Hull
    ctx.fillStyle = t.color;
    roundRect(ctx, -13, -10, 26, 20, 4);
    ctx.fill();
    ctx.stroke();
    // Barrel
    ctx.fillStyle = shade(t.color, -0.35);
    ctx.fillRect(2, -2.6, 25, 5.2);
    ctx.strokeRect(2, -2.6, 25, 5.2);
    // Turret
    ctx.fillStyle = shade(t.color, -0.15);
    ctx.beginPath();
    ctx.arc(0, 0, 7.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgb(255 255 255 / 0.35)";
    ctx.beginPath();
    ctx.arc(-2, -2, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawNames(tanks: DrawTank[]): void {
    const ctx = this.ctx;
    const k = this.scale * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const size = Math.max(10, Math.round(11 * this.dpr));
    ctx.font = `600 ${size}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (const t of tanks) {
      const x = (t.x + PAD) * k;
      const y = (t.y + PAD - TANK_R - 6) * k;
      const label = t.me ? "YOU" : t.name;
      ctx.lineWidth = 3 * this.dpr;
      ctx.strokeStyle = "rgb(0 0 0 / 0.55)";
      ctx.strokeText(label, x, y);
      ctx.fillStyle = t.me ? "#ffffff" : t.color;
      ctx.fillText(label, x, y);
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
