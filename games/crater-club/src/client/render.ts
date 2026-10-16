import { BARREL_LEN, TANK_HALF_W, TURRET_Y, WORLD_H, WORLD_W } from "../shared/constants";
import { hexToRgb, mix, rgba } from "@warrick/kit/client/color";
import { mulberry32 } from "@warrick/kit/shared/rng";
import type { SimEvent, SimTank, World } from "../shared/sim";
import { THEMES, gradientAt, type Theme } from "./themes";

export interface TankInfo {
  name: string;
  color: string;
  angle: number;
  active: boolean;
  you: boolean;
}

export interface DrawOpts {
  theme: number;
  tanks: Map<string, TankInfo>;
  labels: boolean;
  /** Dotted aiming line while the player drags on the map. */
  aimGuide?: { x0: number; y0: number; x1: number; y1: number } | null;
  shooterColor?: string;
}

interface Trail {
  pts: number[];
  color: string;
  tracer: boolean;
  goneAt: number;
}

interface Floater {
  x: number;
  y: number;
  text: string;
  color: string;
  born: number;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const FIRE = ["#fffbe0", "#ffe45c", "#ffb13b", "#ff7424", "#e8381c", "#a3150f"];
const DEATH_FIRE = ["#ffffff", "#ffd0d0", "#ff6b6b", "#ff2d2d", "#b30f2a", "#5c0a1f"];
const TRAIL_FADE_MS = 700;

/** Draws a World onto a canvas. The world is in y-up logical pixels; the canvas is y-down. */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sky = document.createElement("canvas");
  private ground = document.createElement("canvas");
  private groundImg: ImageData;
  private skyTheme = -1;
  private groundWorld: World | null = null;
  private groundVersion = -1;
  private groundTheme = -1;
  private trails = new Map<number, Trail>();
  private tracerPaths: Trail[] = [];
  private floaters: Floater[] = [];
  private shake = 0;
  private flash = 0;
  /** World units per CSS pixel, so labels stay readable at any size. */
  private ui = 1;
  /** What the last frame drawn showed, so a frame that would look the same isn't drawn. */
  private shownWorld: World | null = null;
  private shown = "";
  /** The last frame has something on it that changes by itself (a shake, a flash, a fading trail, a floater). */
  private moving = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    for (const c of [this.sky, this.ground]) {
      c.width = WORLD_W;
      c.height = WORLD_H;
    }
    this.groundImg = new ImageData(WORLD_W, WORLD_H);
  }

  resize(cssWidth: number): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(200, Math.round(cssWidth * dpr));
    const h = Math.round((w * WORLD_H) / WORLD_W);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ui = Math.min(2.2, Math.max(0.8, WORLD_W / Math.max(1, cssWidth)));
  }

  /** Map a pointer position on the canvas element to world coordinates. */
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * WORLD_W;
    const y = WORLD_H - ((clientY - r.top) / r.height) * WORLD_H;
    return { x, y };
  }

  /** Draw the next frame whatever it shows (the fonts have loaded, say). */
  invalidate(): void {
    this.shown = "";
  }

  /** A new World is about to be shown; projectile ids restart, so drop old trails. */
  newShot(): void {
    this.trails.clear();
    this.invalidate();
  }

  clearTracers(): void {
    this.tracerPaths = [];
    this.trails.clear();
    this.invalidate();
  }

  /** Visual reactions to simulation events. */
  onEvent(ev: SimEvent, world: World, now: number, colorOf: (id: string) => string): void {
    this.invalidate();
    if (ev.type === "explode" && !ev.dirt) {
      this.shake = Math.max(this.shake, Math.min(14, ev.r / 6));
      if (ev.r >= 50) this.flash = Math.max(this.flash, Math.min(0.5, ev.r / 200));
    } else if (ev.type === "damage") {
      const t = world.tanks.find((t) => t.id === ev.id);
      if (t) this.floaters.push({ x: t.x, y: t.y + 24, text: `-${ev.amount}`, color: "#ff6b6b", born: now });
    } else if (ev.type === "shield") {
      const t = world.tanks.find((t) => t.id === ev.id);
      if (t) this.floaters.push({ x: t.x, y: t.y + 36, text: "SHIELD", color: colorOf(ev.id), born: now });
    } else if (ev.type === "kill") {
      const t = world.tanks.find((t) => t.id === ev.id);
      if (t) this.floaters.push({ x: t.x, y: t.y + 40, text: "KABOOM", color: "#ffd23f", born: now });
    }
  }

  /**
   * Draw the world, unless the frame would look just like the last one: nothing is moving and
   * nothing changed. Returns whether it drew.
   */
  draw(world: World, opts: DrawOpts, now: number): boolean {
    // The arrow over the tank whose turn it is bobs a whole pixel at a time, so a turn spent
    // thinking redraws a few times a second, not every frame.
    const bob = [...opts.tanks.values()].some((t) => t.active) ? Math.round(Math.sin(now / 180) * 3) : 0;
    const key = JSON.stringify([
      world.tick,
      world.terrainVersion,
      [...opts.tanks],
      opts,
      bob,
      this.canvas.width,
      this.canvas.height,
      this.ui,
    ]);
    if (!this.moving && world === this.shownWorld && key === this.shown) return false;
    this.shownWorld = world;
    this.shown = key;

    const ctx = this.ctx;
    const k = this.canvas.width / WORLD_W;
    const theme = THEMES[opts.theme % THEMES.length];

    if (this.skyTheme !== opts.theme) this.renderSky(theme, opts.theme);
    if (this.groundWorld !== world || this.groundVersion !== world.terrainVersion || this.groundTheme !== opts.theme) {
      this.renderGround(world.heights, theme);
      this.groundWorld = world;
      this.groundVersion = world.terrainVersion;
      this.groundTheme = opts.theme;
    }

    let ox = 0;
    let oy = 0;
    if (this.shake > 0.3) {
      ox = (Math.random() - 0.5) * this.shake;
      oy = (Math.random() - 0.5) * this.shake;
      this.shake *= 0.86;
    } else {
      this.shake = 0;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(k, 0, 0, k, ox * k, oy * k);
    ctx.drawImage(this.sky, 0, 0);

    for (const path of this.tracerPaths) this.drawTrail(path, 0.55, true);

    // Tanks go behind the ground so a buried tank is actually buried.
    for (const t of world.tanks) this.drawTank(t, opts.tanks.get(t.id));
    ctx.drawImage(this.ground, 0, 0);
    for (const t of world.tanks) this.drawTankOverlay(t, opts.tanks.get(t.id), opts.labels, bob);

    this.updateTrails(world, now, opts.shooterColor ?? "#ffffff");
    for (const tr of this.trails.values()) {
      const fade = tr.goneAt ? 1 - (now - tr.goneAt) / TRAIL_FADE_MS : 1;
      this.drawTrail(tr, 0.9 * Math.max(0, fade), tr.tracer);
    }
    for (const p of world.projectiles) {
      if (p.y > WORLD_H) {
        this.drawOffscreenMarker(p.x, p.y);
        continue;
      }
      const y = WORLD_H - p.y;
      ctx.fillStyle = "rgba(255, 230, 160, 0.35)";
      ctx.beginPath();
      ctx.arc(p.x, y, p.rolling ? 6 : 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(p.x, y, p.rolling ? 3.5 : 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const e of world.explosions) this.drawExplosion(e);

    if (opts.aimGuide) this.drawAimGuide(opts.aimGuide);
    this.drawFloaters(now);

    const flashing = this.flash > 0.01;
    if (flashing) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(255, 245, 220, ${this.flash})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.flash *= 0.8;
    }
    // Each of these looks different next frame, until it's gone.
    this.moving = this.shake > 0 || flashing || this.trails.size > 0 || this.floaters.length > 0;
    return true;
  }

  // ---------------------------------------------------------------- backgrounds

  private renderSky(theme: Theme, seed: number): void {
    const g = this.sky.getContext("2d")!;
    const img = g.createImageData(WORLD_W, WORLD_H);
    const d = img.data;
    const BANDS = 28;
    const band = Array.from({ length: BANDS }, (_, i) => gradientAt(theme.sky, i / (BANDS - 1)));
    for (let row = 0; row < WORLD_H; row++) {
      const t = row / (WORLD_H - 1);
      for (let x = 0; x < WORLD_W; x++) {
        const v = t * (BANDS - 1) + (BAYER[(row & 3) * 4 + (x & 3)] / 16 - 0.5);
        const c = band[Math.max(0, Math.min(BANDS - 1, Math.round(v)))];
        const i = (row * WORLD_W + x) * 4;
        d[i] = c[0];
        d[i + 1] = c[1];
        d[i + 2] = c[2];
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    const rng = mulberry32(seed * 7919 + 3);
    if (theme.stars) {
      for (let i = 0; i < 140; i++) {
        const x = Math.floor(rng() * WORLD_W);
        const y = Math.floor(rng() * rng() * WORLD_H * 0.65);
        const a = 0.35 + rng() * 0.65;
        g.fillStyle = `rgba(255, 255, 255, ${a})`;
        g.fillRect(x, y, rng() < 0.15 ? 2 : 1, rng() < 0.15 ? 2 : 1);
      }
    }
    if (theme.moon) {
      const mx = 160 + rng() * (WORLD_W - 320);
      g.fillStyle = theme.moon;
      g.beginPath();
      g.arc(mx, 110, 34, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "rgba(0, 0, 0, 0.12)";
      g.beginPath();
      g.arc(mx - 9, 102, 8, 0, Math.PI * 2);
      g.arc(mx + 12, 120, 5, 0, Math.PI * 2);
      g.fill();
    }
    this.skyTheme = seed;
  }

  private renderGround(heights: number[], theme: Theme): void {
    const d = this.groundImg.data;
    d.fill(0);
    const lo = hexToRgb(theme.ground[0]);
    const hi = hexToRgb(theme.ground[1]);
    const crust = hexToRgb(theme.crust);
    const BANDS = 12;
    const band = Array.from({ length: BANDS }, (_, i) => mix(lo, hi, i / (BANDS - 1)));
    const crust2 = mix(crust, hi, 0.55);
    const span = WORLD_H * 0.8;
    for (let x = 0; x < WORLD_W; x++) {
      const h = heights[x];
      for (let y = 0; y < h; y++) {
        const row = WORLD_H - 1 - y;
        const depth = h - 1 - y;
        let c: [number, number, number];
        if (depth < 2) c = crust;
        else if (depth < 4) c = crust2;
        else {
          const v = (y / span) * (BANDS - 1) + (BAYER[(row & 3) * 4 + (x & 3)] / 16 - 0.5);
          c = band[Math.max(0, Math.min(BANDS - 1, Math.round(v)))];
        }
        const i = (row * WORLD_W + x) * 4;
        d[i] = c[0];
        d[i + 1] = c[1];
        d[i + 2] = c[2];
        d[i + 3] = 255;
      }
    }
    this.ground.getContext("2d")!.putImageData(this.groundImg, 0, 0);
  }

  // ---------------------------------------------------------------- tanks

  private drawTank(t: SimTank, info: TankInfo | undefined): void {
    const ctx = this.ctx;
    const x = t.x;
    const base = WORLD_H - t.y;
    const color = t.alive ? (info?.color ?? "#cccccc") : "#5d5d6b";

    if (t.alive && info) {
      const a = (info.angle * Math.PI) / 180;
      ctx.strokeStyle = shade(color, 0.25);
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x, base - TURRET_Y);
      ctx.lineTo(x + Math.cos(a) * BARREL_LEN, base - TURRET_Y - Math.sin(a) * BARREL_LEN);
      ctx.stroke();
    }

    ctx.fillStyle = shade(color, -0.5);
    ctx.beginPath();
    ctx.roundRect(x - TANK_HALF_W, base - 4, TANK_HALF_W * 2, 4, 2);
    ctx.fill();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - 9, base - 3);
    ctx.lineTo(x - 6.5, base - 8);
    ctx.lineTo(x + 6.5, base - 8);
    ctx.lineTo(x + 9, base - 3);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, base - 8, 4.6, Math.PI, 0);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(x - 6, base - 7.5, 12, 1);

    if (!t.alive) {
      ctx.fillStyle = "rgba(20,20,24,0.6)";
      ctx.beginPath();
      ctx.arc(x - 3, base - 14, 4, 0, Math.PI * 2);
      ctx.arc(x + 2, base - 19, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawTankOverlay(t: SimTank, info: TankInfo | undefined, labels: boolean, bob: number): void {
    if (!info) return;
    const ctx = this.ctx;
    const x = t.x;
    const base = WORLD_H - t.y;
    const u = this.ui;

    if (t.alive && t.shield > 0) {
      ctx.strokeStyle = rgba(info.color, 0.8);
      ctx.fillStyle = rgba(info.color, 0.12);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, base - 6, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (t.chute) {
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x - 12, base - 30);
      ctx.lineTo(x - 5, base - 9);
      ctx.moveTo(x + 12, base - 30);
      ctx.lineTo(x + 5, base - 9);
      ctx.stroke();
      ctx.fillStyle = "#f4f4f4";
      ctx.beginPath();
      ctx.arc(x, base - 30, 13, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = info.color;
      ctx.fillRect(x - 3, base - 43, 6, 13);
    }

    if (!labels || !t.alive) return;

    const fontPx = 11 * u;
    const labelY = base - 22 - 2 * u;
    ctx.font = `600 ${fontPx}px "IBM Plex Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.strokeText(info.name, x, labelY - 6 * u);
    ctx.fillStyle = info.you ? "#ffffff" : shade(info.color, 0.35);
    ctx.fillText(info.name, x, labelY - 6 * u);

    const bw = 28 * Math.max(1, u * 0.8);
    const bh = 3 * u;
    const hp = Math.max(0, t.health) / 100;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(x - bw / 2 - 1, labelY - 2 * u - 1, bw + 2, bh + 2);
    ctx.fillStyle = hp > 0.6 ? "#5ce65c" : hp > 0.3 ? "#ffd23f" : "#ff4d5e";
    ctx.fillRect(x - bw / 2, labelY - 2 * u, bw * hp, bh);

    if (info.active) {
      const ty = labelY - 6 * u - fontPx - 6 - bob;
      ctx.fillStyle = "#ffd23f";
      ctx.beginPath();
      ctx.moveTo(x - 6 * u, ty - 7 * u);
      ctx.lineTo(x + 6 * u, ty - 7 * u);
      ctx.lineTo(x, ty);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ---------------------------------------------------------------- shots

  private updateTrails(world: World, now: number, color: string): void {
    const alive = new Set<number>();
    for (const p of world.projectiles) {
      alive.add(p.id);
      let tr = this.trails.get(p.id);
      if (!tr) {
        tr = { pts: [], color: p.kind === "tracer" ? "#9ff7ff" : lighten(color, 0.45), tracer: p.kind === "tracer", goneAt: 0 };
        this.trails.set(p.id, tr);
      }
      const n = tr.pts.length;
      const lx = tr.pts[n - 2];
      const ly = tr.pts[n - 1];
      if (n >= 2 && Math.abs(p.x - lx) > 300) tr.pts.push(NaN, NaN); // wrapped around
      if (n < 2 || Math.hypot(p.x - lx, p.y - ly) > 1.5) tr.pts.push(p.x, p.y);
      if (!tr.tracer && tr.pts.length > 140) tr.pts.splice(0, tr.pts.length - 140);
    }
    for (const [id, tr] of this.trails) {
      if (alive.has(id)) continue;
      if (tr.tracer) {
        this.tracerPaths.push(tr);
        this.trails.delete(id);
      } else if (!tr.goneAt) {
        tr.goneAt = now;
      } else if (now - tr.goneAt > TRAIL_FADE_MS) {
        this.trails.delete(id);
      }
    }
  }

  private drawTrail(tr: Trail, alpha: number, dotted: boolean): void {
    if (alpha <= 0 || tr.pts.length < 4) return;
    const ctx = this.ctx;
    ctx.strokeStyle = rgba(tr.color, alpha);
    ctx.lineWidth = dotted ? 1.4 : 1.6;
    ctx.setLineDash(dotted ? [3, 4] : []);
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < tr.pts.length; i += 2) {
      const x = tr.pts[i];
      const y = tr.pts[i + 1];
      if (Number.isNaN(x)) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(x, WORLD_H - y);
      else ctx.moveTo(x, WORLD_H - y);
      pen = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawOffscreenMarker(x: number, y: number): void {
    const ctx = this.ctx;
    const u = this.ui;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.moveTo(x, 3);
    ctx.lineTo(x - 5 * u, 3 + 8 * u);
    ctx.lineTo(x + 5 * u, 3 + 8 * u);
    ctx.closePath();
    ctx.fill();
    ctx.font = `${9 * u}px "IBM Plex Mono", monospace`;
    ctx.textAlign = "center";
    ctx.fillText(String(Math.round(y - WORLD_H)), x, 3 + 19 * u);
  }

  private drawExplosion(e: World["explosions"][number]): void {
    const ctx = this.ctx;
    const grow = Math.min(1, e.age / e.peak);
    const ease = 1 - (1 - grow) ** 3;
    const fade = e.age <= e.peak ? 1 : Math.max(0, 1 - (e.age - e.peak) / (e.life - e.peak));
    const r = Math.max(2, e.r * ease);
    const x = e.x;
    const y = WORLD_H - e.y;
    ctx.globalAlpha = fade;
    if (e.dirt) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "#b07a45");
      g.addColorStop(0.8, "#6b4422");
      g.addColorStop(1, "rgba(60, 36, 18, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Classic concentric, color-cycling fireball.
      const pal = e.death ? DEATH_FIRE : FIRE;
      const rings = 6;
      const cycle = Math.floor(e.age / 2);
      for (let i = 0; i < rings; i++) {
        ctx.fillStyle = pal[(rings - 1 - i + cycle) % pal.length];
        ctx.beginPath();
        ctx.arc(x, y, r * (1 - i / rings), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawAimGuide(g: { x0: number; y0: number; x1: number; y1: number }): void {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(255, 210, 63, 0.8)";
    ctx.lineWidth = 1.5 * this.ui;
    ctx.setLineDash([4 * this.ui, 5 * this.ui]);
    ctx.beginPath();
    ctx.moveTo(g.x0, WORLD_H - g.y0);
    ctx.lineTo(g.x1, WORLD_H - g.y1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(g.x1, WORLD_H - g.y1, 5 * this.ui, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawFloaters(now: number): void {
    const ctx = this.ctx;
    const u = this.ui;
    ctx.textAlign = "center";
    ctx.font = `${10 * u}px "Press Start 2P", monospace`;
    this.floaters = this.floaters.filter((f) => now - f.born < 1400);
    for (const f of this.floaters) {
      const t = (now - f.born) / 1400;
      const y = WORLD_H - f.y - t * 34;
      ctx.globalAlpha = 1 - t * t;
      ctx.lineWidth = 3 * u;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.strokeText(f.text, f.x, y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, y);
    }
    ctx.globalAlpha = 1;
  }
}

function shade(hex: string, amt: number): string {
  const c = hexToRgb(hex);
  const target: [number, number, number] = amt < 0 ? [0, 0, 0] : [255, 255, 255];
  const m = mix(c, target, Math.abs(amt));
  return `rgb(${m[0] | 0}, ${m[1] | 0}, ${m[2] | 0})`;
}

function lighten(hex: string, amt: number): string {
  const m = mix(hexToRgb(hex), [255, 255, 255], amt);
  return `#${m.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}
