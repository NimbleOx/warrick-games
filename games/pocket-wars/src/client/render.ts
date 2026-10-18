// The map on a canvas: a cached terrain layer, then buildings, overlays, units and effects,
// all drawn in tile units under a pan-and-zoom camera. No image files: everything is paths.
import type { MapDef } from "../shared/maps";
import type { Board, Unit } from "../shared/rules";
import { CAPTURE_POINTS, type Terrain } from "../shared/terrain";
import { MAX_HP, type UnitType } from "../shared/units";

export interface Ghost {
  unit: Unit;
  /** Position in tiles (fractional while moving). */
  x: number;
  y: number;
  scale?: number;
  alpha?: number;
}

export interface Overlay {
  /** Tiles the selected unit can move to. */
  move?: Iterable<number>;
  /** Tiles a unit could attack (red). */
  danger?: Iterable<number>;
  path?: number[];
  /** Attackable units, with the damage label and whether it's the one being looked at. */
  targets?: { tile: number; label?: string; focus?: boolean }[];
  /** Tile with a selection bracket. */
  selected?: number;
  cursor?: number;
}

export interface Scene {
  m: MapDef;
  b: Board;
  /** Player colour by seat. */
  colors: readonly string[];
  /** Units whose turn it is show as done (greyed) once they've acted. */
  activeSeat: number;
  /** Units drawn as ghosts instead of where the board has them. */
  hide?: Set<number>;
  ghosts?: Ghost[];
  overlay?: Overlay;
}

interface Effect {
  kind: "float" | "boom" | "flash";
  x: number;
  y: number;
  start: number;
  dur: number;
  text?: string;
  color?: string;
}

const NEUTRAL = "#d9d9d2";
const MIN_SCALE = 10;
const MAX_SCALE = 96;

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  /** CSS pixels. */
  w = 300;
  h = 200;
  private dpr = 1;
  /** Camera: CSS pixels per tile, and where the map's top-left corner sits. */
  scale = 32;
  ox = 0;
  oy = 0;
  private cache: { key: string; canvas: HTMLCanvasElement } | null = null;
  private fx: Effect[] = [];

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(w: number, h: number): void {
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.w = Math.max(50, Math.floor(w));
    this.h = Math.max(50, Math.floor(h));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
  }

  // ---------------------------------------------------------------- camera

  fitScale(m: MapDef): number {
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(this.w / m.w, this.h / m.h)));
  }

  fit(m: MapDef): void {
    this.scale = this.fitScale(m);
    this.ox = (this.w - m.w * this.scale) / 2;
    this.oy = (this.h - m.h * this.scale) / 2;
  }

  /** Zoom to `scale` (at least the fit) with `tile` in the middle. */
  centerOn(m: MapDef, tile: number, scale = this.scale): void {
    this.scale = Math.max(this.fitScale(m), Math.min(MAX_SCALE, scale));
    const x = (tile % m.w) + 0.5;
    const y = Math.floor(tile / m.w) + 0.5;
    this.ox = this.w / 2 - x * this.scale;
    this.oy = this.h / 2 - y * this.scale;
    this.clamp(m);
  }

  /** Zoom by `factor` keeping the point (cx, cy) in CSS pixels still. */
  zoom(m: MapDef, factor: number, cx = this.w / 2, cy = this.h / 2): void {
    const next = Math.max(this.fitScale(m), Math.min(MAX_SCALE, this.scale * factor));
    const k = next / this.scale;
    this.ox = cx - (cx - this.ox) * k;
    this.oy = cy - (cy - this.oy) * k;
    this.scale = next;
    this.clamp(m);
  }

  pan(m: MapDef, dx: number, dy: number): void {
    this.ox += dx;
    this.oy += dy;
    this.clamp(m);
  }

  /** Keep the map on screen: centred along an axis where it fits, edge to edge where it doesn't. */
  clamp(m: MapDef): void {
    const mw = m.w * this.scale;
    const mh = m.h * this.scale;
    const pad = this.scale * 0.5;
    this.ox = mw <= this.w ? (this.w - mw) / 2 : Math.min(pad, Math.max(this.w - mw - pad, this.ox));
    this.oy = mh <= this.h ? (this.h - mh) / 2 : Math.min(pad, Math.max(this.h - mh - pad, this.oy));
  }

  /** The tile under a point on the page, or -1. */
  tileAt(m: MapDef, clientX: number, clientY: number): number {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - r.left - this.ox) / this.scale);
    const y = Math.floor((clientY - r.top - this.oy) / this.scale);
    return x >= 0 && y >= 0 && x < m.w && y < m.h ? y * m.w + x : -1;
  }

  /** A tile's box in CSS pixels, relative to the canvas. */
  tileRect(m: MapDef, t: number): { x: number; y: number; size: number } {
    return { x: this.ox + (t % m.w) * this.scale, y: this.oy + Math.floor(t / m.w) * this.scale, size: this.scale };
  }

  // ---------------------------------------------------------------- effects

  float(m: MapDef, tile: number, text: string, color: string, delay = 0): void {
    this.add({ kind: "float", x: tile % m.w, y: Math.floor(tile / m.w), start: performance.now() + delay, dur: 1100, text, color });
  }

  boom(m: MapDef, tile: number, delay = 0): void {
    this.add({ kind: "boom", x: tile % m.w, y: Math.floor(tile / m.w), start: performance.now() + delay, dur: 650 });
  }

  flash(m: MapDef, tile: number, delay = 0): void {
    this.add({ kind: "flash", x: tile % m.w, y: Math.floor(tile / m.w), start: performance.now() + delay, dur: 220 });
  }

  /** Effects are dropped as they finish, here too: a hidden tab adds them without drawing. */
  private add(e: Effect): void {
    const now = performance.now();
    this.fx = this.fx.filter((f) => now < f.start + f.dur).slice(-40);
    this.fx.push(e);
  }

  clearEffects(): void {
    this.fx = [];
  }

  get busy(): boolean {
    return this.fx.length > 0;
  }

  // ---------------------------------------------------------------- drawing

  draw(sc: Scene, now: number): void {
    const { ctx, m } = { ctx: this.ctx, m: sc.m };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0b1a10";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, this.dpr * this.ox, this.dpr * this.oy);

    const terrain = this.terrain(m);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(terrain, 0, 0, m.w, m.h);

    m.buildings.forEach((bd, i) => drawBuilding(ctx, bd.x, bd.y, bd.kind, colorOf(sc, sc.b.owners[i])));

    const o = sc.overlay ?? {};
    if (o.move) for (const t of o.move) tileFill(ctx, m, t, "rgba(90, 170, 255, 0.42)", "rgba(220, 240, 255, 0.55)", this.scale);
    if (o.danger) for (const t of o.danger) tileFill(ctx, m, t, "rgba(255, 70, 70, 0.32)", "rgba(255, 190, 190, 0.45)", this.scale);
    if (o.path && o.path.length > 1) drawPath(ctx, m, o.path, this.scale);

    const units = [...sc.b.units].filter((u) => !sc.hide?.has(u.id)).sort((a, c) => a.y - c.y);
    for (const u of units) {
      drawUnit(ctx, u.type, u.x, u.y, colorOf(sc, u.seat), faceOf(m, u.seat), u.done && u.seat === sc.activeSeat);
    }
    for (const g of sc.ghosts ?? []) {
      ctx.save();
      ctx.globalAlpha = g.alpha ?? 1;
      const s = g.scale ?? 1;
      ctx.translate(g.x + 0.5, g.y + 0.5);
      ctx.scale(s, s);
      drawUnit(ctx, g.unit.type, -0.5, -0.5, colorOf(sc, g.unit.seat), faceOf(m, g.unit.seat), false);
      ctx.restore();
    }

    // Capture progress on buildings someone is standing on.
    m.buildings.forEach((bd, i) => {
      const left = sc.b.capture[i];
      if (left < CAPTURE_POINTS) this.badge(bd.x + 0.02, bd.y + 0.02, `${left}`, "#ffd23f", "#2a2000", true);
    });
    // HP badges, in screen space so the digits stay sharp.
    for (const u of units) if (u.hp < MAX_HP) this.badge(u.x + 0.6, u.y + 0.6, String(Math.max(1, u.hp)), "#fff", "#111");
    for (const g of sc.ghosts ?? []) if (g.unit.hp < MAX_HP && (g.alpha ?? 1) > 0.5) this.badge(g.x + 0.6, g.y + 0.6, String(Math.max(1, g.unit.hp)), "#fff", "#111");

    if (o.targets) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 160);
      for (const tg of o.targets) {
        const x = tg.tile % m.w;
        const y = Math.floor(tg.tile / m.w);
        ctx.lineWidth = (tg.focus ? 3.5 : 2.5) / this.scale;
        ctx.strokeStyle = tg.focus ? "#fff" : `rgba(255, ${80 + 100 * pulse}, ${80 + 100 * pulse}, 1)`;
        ctx.strokeRect(x + 0.06, y + 0.06, 0.88, 0.88);
        if (tg.label) this.label(x + 0.5, y - 0.02, tg.label, tg.focus ? "#ffd23f" : "#fff", "rgba(150, 0, 20, 0.92)");
      }
    }
    if (o.selected !== undefined) brackets(ctx, m, o.selected, "#ffd23f", this.scale, now);
    if (o.cursor !== undefined && o.cursor >= 0) {
      ctx.lineWidth = 2 / this.scale;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.strokeRect((o.cursor % m.w) + 0.04, Math.floor(o.cursor / m.w) + 0.04, 0.92, 0.92);
    }

    this.drawEffects(now);
  }

  private drawEffects(now: number): void {
    const ctx = this.ctx;
    this.fx = this.fx.filter((e) => now < e.start + e.dur);
    for (const e of this.fx) {
      const t = (now - e.start) / e.dur;
      if (t < 0) continue;
      if (e.kind === "flash") {
        ctx.fillStyle = `rgba(255, 255, 255, ${0.75 * (1 - t)})`;
        ctx.fillRect(e.x, e.y, 1, 1);
      } else if (e.kind === "boom") {
        const cx = e.x + 0.5;
        const cy = e.y + 0.5;
        ctx.fillStyle = `rgba(255, 170, 40, ${0.9 * (1 - t)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, 0.15 + 0.55 * t, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255, 245, 200, ${0.9 * (1 - t) ** 2})`;
        ctx.beginPath();
        ctx.arc(cx, cy, 0.1 + 0.3 * t, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + 0.4;
          ctx.fillStyle = `rgba(60, 50, 45, ${0.7 * (1 - t)})`;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * 0.6 * t, cy + Math.sin(a) * 0.6 * t - 0.2 * t, 0.12 * (1 - t) + 0.04, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (e.text) {
        const ease = 1 - (1 - Math.min(1, t * 1.6)) ** 2;
        ctx.save();
        ctx.globalAlpha = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
        this.label(e.x + 0.5, e.y + 0.35 - ease * 0.55, e.text, e.color ?? "#fff", "rgba(10, 10, 20, 0.85)");
        ctx.restore();
      }
    }
  }

  /** A small box with text, centred above (x, y) in tiles. Drawn in screen pixels. */
  private label(x: number, y: number, text: string, color: string, bg: string): void {
    const ctx = this.ctx;
    const px = Math.max(9, Math.min(14, this.scale * 0.32));
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = `${px}px "Press Start 2P", ui-monospace, monospace`;
    const sx = this.ox + x * this.scale;
    const sy = this.oy + y * this.scale;
    const w = ctx.measureText(text).width + px * 0.9;
    const h = px * 1.7;
    ctx.fillStyle = bg;
    ctx.fillRect(Math.round(sx - w / 2), Math.round(sy - h), Math.round(w), Math.round(h));
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, Math.round(sx), Math.round(sy - h / 2 + 1));
    ctx.restore();
  }

  /** A small number box at (x, y) in tiles (its top-left). */
  private badge(x: number, y: number, text: string, color: string, bg: string, flag = false): void {
    const ctx = this.ctx;
    const size = Math.max(8, Math.min(13, this.scale * 0.36));
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = `${size}px "Press Start 2P", ui-monospace, monospace`;
    const sx = Math.round(this.ox + x * this.scale);
    const sy = Math.round(this.oy + y * this.scale);
    const w = Math.round(ctx.measureText(text).width + size * 0.5 + (flag ? size * 0.8 : 0));
    const h = Math.round(size * 1.35);
    ctx.fillStyle = bg;
    ctx.fillRect(sx, sy, w, h);
    ctx.fillStyle = color;
    if (flag) {
      ctx.fillRect(sx + size * 0.25, sy + size * 0.2, size * 0.12, h - size * 0.4);
      ctx.beginPath();
      ctx.moveTo(sx + size * 0.37, sy + size * 0.2);
      ctx.lineTo(sx + size * 0.85, sy + size * 0.4);
      ctx.lineTo(sx + size * 0.37, sy + size * 0.65);
      ctx.fill();
    }
    ctx.textBaseline = "middle";
    ctx.fillText(text, sx + size * 0.25 + (flag ? size * 0.8 : 0), sy + h / 2 + 1);
    ctx.restore();
  }

  /** The terrain layer, drawn once per map at a resolution near the screen's. */
  private terrain(m: MapDef): HTMLCanvasElement {
    const want = this.scale * this.dpr;
    const px = want <= 24 ? 24 : want <= 48 ? 48 : 96;
    const key = `${m.id}:${px}`;
    if (this.cache?.key === key) return this.cache.canvas;
    const c = document.createElement("canvas");
    c.width = m.w * px;
    c.height = m.h * px;
    const g = c.getContext("2d")!;
    g.scale(px, px);
    drawTerrain(g, m, px);
    this.cache = { key, canvas: c };
    return c;
  }
}

function colorOf(sc: Scene, seat: number): string {
  return seat >= 0 ? (sc.colors[seat] ?? NEUTRAL) : NEUTRAL;
}

/** Armies on the left half of the map face right, the others left. */
export function faceOf(m: MapDef, seat: number): 1 | -1 {
  const hq = m.buildings[m.hq[seat]];
  return !hq || hq.x < m.w / 2 ? 1 : -1;
}

// ------------------------------------------------------------------ colour helpers

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

function mix(hex: string, other: string, k: number): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(other.slice(1), 16);
  const f = (s: number) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
  return `#${[16, 8, 0].map((s) => f(s).toString(16).padStart(2, "0")).join("")}`;
}

function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ terrain

const PLAINS = "#7cc25b";
const PLAINS_DARK = "#62a948";
const WATER = "#3e9be0";
const SEA = "#2b62b0";

function isWet(t: Terrain): boolean {
  return t === "river" || t === "sea" || t === "bridge";
}

function joins(t: Terrain): boolean {
  return t === "road" || t === "bridge" || t === "city" || t === "factory" || t === "hq";
}

function drawTerrain(g: CanvasRenderingContext2D, m: MapDef, px: number): void {
  const at = (x: number, y: number): Terrain | null => (x < 0 || y < 0 || x >= m.w || y >= m.h ? null : m.tiles[y * m.w + x]);
  const lw = 1 / px;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const t = m.tiles[y * m.w + x];
      const r = hash(y * m.w + x + m.w * 1000);
      const r2 = hash(y * 977 + x * 131 + 7);
      if (t === "sea") {
        g.fillStyle = SEA;
        g.fillRect(x, y, 1, 1);
        // Sand where the sea meets land.
        g.fillStyle = "#e7d49a";
        const land = (nx: number, ny: number) => {
          const n = at(nx, ny);
          return n !== null && n !== "sea" && n !== "river";
        };
        if (land(x - 1, y)) g.fillRect(x, y, 0.12, 1);
        if (land(x + 1, y)) g.fillRect(x + 0.88, y, 0.12, 1);
        if (land(x, y - 1)) g.fillRect(x, y, 1, 0.12);
        if (land(x, y + 1)) g.fillRect(x, y + 0.88, 1, 0.12);
        waves(g, x, y, "#5a8fdc", r);
        continue;
      }
      if (t === "river" || t === "bridge") {
        g.fillStyle = PLAINS;
        g.fillRect(x, y, 1, 1);
        // The channel runs toward neighbouring water, so rivers look joined up.
        g.fillStyle = WATER;
        const wet = (nx: number, ny: number) => {
          const n = at(nx, ny);
          return n === null || isWet(n);
        };
        const k = 0.16;
        g.fillRect(x + k, y + k, 1 - 2 * k, 1 - 2 * k);
        if (wet(x - 1, y)) g.fillRect(x, y + k, k, 1 - 2 * k);
        if (wet(x + 1, y)) g.fillRect(x + 1 - k, y + k, k, 1 - 2 * k);
        if (wet(x, y - 1)) g.fillRect(x + k, y, 1 - 2 * k, k);
        if (wet(x, y + 1)) g.fillRect(x + k, y + 1 - k, 1 - 2 * k, k);
        if (t === "river") waves(g, x, y, "#86ccff", r);
        else {
          const horiz = joins(at(x - 1, y) ?? "sea") || joins(at(x + 1, y) ?? "sea");
          g.fillStyle = "#a9794a";
          g.strokeStyle = "#6e4a2a";
          g.lineWidth = lw * 1.5;
          if (horiz) {
            g.fillRect(x, y + 0.24, 1, 0.52);
            g.strokeRect(x, y + 0.24, 1, 0.52);
            for (let i = 1; i < 5; i++) {
              g.beginPath();
              g.moveTo(x + i * 0.2, y + 0.24);
              g.lineTo(x + i * 0.2, y + 0.76);
              g.stroke();
            }
          } else {
            g.fillRect(x + 0.24, y, 0.52, 1);
            g.strokeRect(x + 0.24, y, 0.52, 1);
            for (let i = 1; i < 5; i++) {
              g.beginPath();
              g.moveTo(x + 0.24, y + i * 0.2);
              g.lineTo(x + 0.76, y + i * 0.2);
              g.stroke();
            }
          }
        }
        continue;
      }
      g.fillStyle = PLAINS;
      g.fillRect(x, y, 1, 1);
      tufts(g, x, y, r, r2);
      if (t === "road" || t === "city" || t === "factory" || t === "hq") road(g, x, y, t === "road", at, lw);
      if (t === "forest") forest(g, x, y, r);
      if (t === "mountain") mountain(g, x, y, r);
    }
  }
  // Faint grid.
  g.strokeStyle = "rgba(0, 0, 0, 0.12)";
  g.lineWidth = lw;
  g.beginPath();
  for (let x = 1; x < m.w; x++) {
    g.moveTo(x, 0);
    g.lineTo(x, m.h);
  }
  for (let y = 1; y < m.h; y++) {
    g.moveTo(0, y);
    g.lineTo(m.w, y);
  }
  g.stroke();
}

function tufts(g: CanvasRenderingContext2D, x: number, y: number, r: number, r2: number): void {
  g.fillStyle = PLAINS_DARK;
  for (let i = 0; i < 3; i++) {
    const tx = x + 0.15 + ((r * (i + 3) * 7.13) % 0.7);
    const ty = y + 0.15 + ((r2 * (i + 5) * 5.71) % 0.7);
    g.fillRect(tx, ty, 0.06, 0.1);
    g.fillRect(tx + 0.08, ty + 0.03, 0.06, 0.07);
  }
}

function waves(g: CanvasRenderingContext2D, x: number, y: number, color: string, r: number): void {
  g.strokeStyle = color;
  g.lineWidth = 0.05;
  g.lineCap = "round";
  for (let i = 0; i < 2; i++) {
    const wx = x + 0.25 + ((r * (i + 2) * 3.3) % 0.4);
    const wy = y + 0.3 + i * 0.35;
    g.beginPath();
    g.moveTo(wx - 0.12, wy);
    g.quadraticCurveTo(wx - 0.06, wy - 0.08, wx, wy);
    g.quadraticCurveTo(wx + 0.06, wy + 0.08, wx + 0.12, wy);
    g.stroke();
  }
}

function road(g: CanvasRenderingContext2D, x: number, y: number, full: boolean, at: (x: number, y: number) => Terrain | null, lw: number): void {
  const w = 0.42;
  const a = (1 - w) / 2;
  const links = [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ].map(([nx, ny]) => {
    const n = at(nx, ny);
    return n !== null && (n === "road" || n === "bridge" || (full && joins(n)));
  });
  if (!full && !links.some(Boolean)) return;
  g.fillStyle = "#c7bfa9";
  g.fillRect(x + a, y + a, w, w);
  if (links[0]) g.fillRect(x, y + a, a, w);
  if (links[1]) g.fillRect(x + a + w, y + a, a, w);
  if (links[2]) g.fillRect(x + a, y, w, a);
  if (links[3]) g.fillRect(x + a, y + a + w, w, a);
  // Kerbs.
  g.fillStyle = "#9b927c";
  const k = lw * 2;
  if (!links[2]) g.fillRect(x + a, y + a, w, k);
  if (!links[3]) g.fillRect(x + a, y + a + w - k, w, k);
  if (!links[0]) g.fillRect(x + a, y + a, k, w);
  if (!links[1]) g.fillRect(x + a + w - k, y + a, k, w);
  if (links[0] || links[1]) {
    if (!links[2]) g.fillRect(links[0] ? x : x + a, y + a, (links[0] ? a : 0) + w + (links[1] ? a : 0), k);
    if (!links[3]) g.fillRect(links[0] ? x : x + a, y + a + w - k, (links[0] ? a : 0) + w + (links[1] ? a : 0), k);
  }
  if (links[2] || links[3]) {
    if (!links[0]) g.fillRect(x + a, links[2] ? y : y + a, k, (links[2] ? a : 0) + w + (links[3] ? a : 0));
    if (!links[1]) g.fillRect(x + a + w - k, links[2] ? y : y + a, k, (links[2] ? a : 0) + w + (links[3] ? a : 0));
  }
}

function forest(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const trees = [
    [0.3, 0.42, 0.26],
    [0.68, 0.36, 0.24],
    [0.5, 0.7, 0.27],
  ];
  for (const [tx, ty, s] of trees) {
    const cx = x + tx + (r - 0.5) * 0.06;
    const cy = y + ty;
    g.fillStyle = "#6b4a2b";
    g.fillRect(cx - 0.03, cy + s * 0.55, 0.06, s * 0.35);
    g.fillStyle = "#2f7d35";
    g.beginPath();
    g.moveTo(cx, cy - s * 0.75);
    g.lineTo(cx + s * 0.6, cy + s * 0.6);
    g.lineTo(cx - s * 0.6, cy + s * 0.6);
    g.closePath();
    g.fill();
    g.fillStyle = "#205e27";
    g.beginPath();
    g.moveTo(cx, cy - s * 0.75);
    g.lineTo(cx + s * 0.6, cy + s * 0.6);
    g.lineTo(cx, cy + s * 0.6);
    g.closePath();
    g.fill();
  }
}

function mountain(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const peak = (cx: number, base: number, hw: number, top: number) => {
    g.fillStyle = "#a48459";
    g.beginPath();
    g.moveTo(cx - hw, base);
    g.lineTo(cx, top);
    g.lineTo(cx + hw, base);
    g.closePath();
    g.fill();
    g.fillStyle = "#7c6142";
    g.beginPath();
    g.moveTo(cx, top);
    g.lineTo(cx + hw, base);
    g.lineTo(cx + hw * 0.15, base);
    g.closePath();
    g.fill();
    g.fillStyle = "#f4f4f0";
    const sh = (base - top) * 0.3;
    g.beginPath();
    g.moveTo(cx, top);
    g.lineTo(cx + hw * (sh / (base - top)), top + sh);
    g.lineTo(cx, top + sh * 0.75);
    g.lineTo(cx - hw * (sh / (base - top)), top + sh);
    g.closePath();
    g.fill();
  };
  peak(x + 0.68, y + 0.86, 0.3, y + 0.32 + r * 0.05);
  peak(x + 0.38, y + 0.9, 0.36, y + 0.1);
}

// ------------------------------------------------------------------ buildings

function drawBuilding(g: CanvasRenderingContext2D, x: number, y: number, kind: "city" | "factory" | "hq", color: string): void {
  const body = color;
  const roof = shade(color === NEUTRAL ? "#b5b5ad" : color, -0.35);
  const dark = "rgba(20, 20, 30, 0.85)";
  g.lineWidth = 0.04;
  g.strokeStyle = "rgba(10, 10, 20, 0.7)";
  g.lineJoin = "round";
  if (kind === "city") {
    g.fillStyle = body;
    g.fillRect(x + 0.2, y + 0.42, 0.6, 0.46);
    g.strokeRect(x + 0.2, y + 0.42, 0.6, 0.46);
    g.fillStyle = roof;
    g.beginPath();
    g.moveTo(x + 0.12, y + 0.44);
    g.lineTo(x + 0.5, y + 0.14);
    g.lineTo(x + 0.88, y + 0.44);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = dark;
    g.fillRect(x + 0.44, y + 0.64, 0.12, 0.24);
    g.fillStyle = "#ffeaa0";
    g.fillRect(x + 0.27, y + 0.52, 0.11, 0.1);
    g.fillRect(x + 0.62, y + 0.52, 0.11, 0.1);
  } else if (kind === "factory") {
    g.fillStyle = shade(body, -0.15);
    g.fillRect(x + 0.66, y + 0.12, 0.12, 0.34);
    g.strokeRect(x + 0.66, y + 0.12, 0.12, 0.34);
    g.fillStyle = body;
    g.beginPath();
    g.moveTo(x + 0.1, y + 0.88);
    g.lineTo(x + 0.1, y + 0.44);
    for (let i = 0; i < 3; i++) {
      const sx = x + 0.1 + i * 0.27;
      g.lineTo(sx + 0.27, y + 0.3);
      g.lineTo(sx + 0.27, y + 0.44);
    }
    g.lineTo(x + 0.91, y + 0.88);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = roof;
    for (let i = 0; i < 3; i++) g.fillRect(x + 0.14 + i * 0.27, y + 0.47, 0.2, 0.06);
    g.fillStyle = dark;
    g.fillRect(x + 0.36, y + 0.62, 0.28, 0.26);
    g.strokeStyle = "rgba(255,255,255,0.25)";
    g.beginPath();
    g.moveTo(x + 0.36, y + 0.7);
    g.lineTo(x + 0.64, y + 0.7);
    g.moveTo(x + 0.36, y + 0.78);
    g.lineTo(x + 0.64, y + 0.78);
    g.stroke();
  } else {
    g.fillStyle = body;
    g.fillRect(x + 0.16, y + 0.5, 0.68, 0.38);
    g.strokeRect(x + 0.16, y + 0.5, 0.68, 0.38);
    g.fillRect(x + 0.32, y + 0.26, 0.36, 0.28);
    g.strokeRect(x + 0.32, y + 0.26, 0.36, 0.28);
    g.fillStyle = roof;
    g.fillRect(x + 0.16, y + 0.5, 0.68, 0.07);
    g.fillRect(x + 0.32, y + 0.26, 0.36, 0.06);
    g.fillStyle = dark;
    g.fillRect(x + 0.43, y + 0.68, 0.14, 0.2);
    // Flagpole and flag.
    g.fillStyle = "#2a2a2a";
    g.fillRect(x + 0.48, y + 0.02, 0.04, 0.26);
    g.fillStyle = color === NEUTRAL ? "#f2f2f2" : shade(color, 0.15);
    g.beginPath();
    g.moveTo(x + 0.52, y + 0.03);
    g.lineTo(x + 0.82, y + 0.1);
    g.lineTo(x + 0.52, y + 0.18);
    g.closePath();
    g.fill();
    g.stroke();
    star(g, x + 0.5, y + 0.4, 0.08, "#ffd23f");
  }
}

function star(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}

// ------------------------------------------------------------------ units

/** One unit in tile units at (x, y), facing right (1) or left (-1). Done units are greyed. */
export function drawUnit(g: CanvasRenderingContext2D, type: UnitType, x: number, y: number, color: string, face: 1 | -1, done: boolean): void {
  const body = done ? mix(color, "#6a6a6a", 0.65) : color;
  const dark = shade(body.startsWith("#") ? body : color, -0.45);
  const light = shade(body.startsWith("#") ? body : color, 0.35);
  const ink = "#15151c";
  g.save();
  g.translate(x + 0.5, y + 0.5);
  g.scale(face, 1);
  g.translate(-0.5, -0.5);
  g.lineWidth = 0.05;
  g.lineJoin = "round";
  g.lineCap = "round";
  g.strokeStyle = ink;
  // Shadow.
  g.fillStyle = "rgba(0, 0, 0, 0.28)";
  g.beginPath();
  g.ellipse(0.5, 0.86, 0.34, 0.08, 0, 0, Math.PI * 2);
  g.fill();

  const rr = (x0: number, y0: number, w: number, h: number, r: number, fill: string) => {
    g.fillStyle = fill;
    g.beginPath();
    g.roundRect(x0, y0, w, h, r);
    g.fill();
    g.stroke();
  };
  const circle = (cx: number, cy: number, r: number, fill: string) => {
    g.fillStyle = fill;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  };

  switch (type) {
    case "infantry":
    case "bazooka": {
      rr(0.36, 0.7, 0.1, 0.16, 0.03, dark);
      rr(0.52, 0.7, 0.1, 0.16, 0.03, dark);
      rr(0.32, 0.42, 0.34, 0.32, 0.08, body);
      circle(0.49, 0.3, 0.12, "#f1c9a0");
      g.fillStyle = dark;
      g.beginPath();
      g.arc(0.49, 0.28, 0.13, Math.PI, 0);
      g.closePath();
      g.fill();
      g.stroke();
      if (type === "bazooka") {
        g.save();
        g.translate(0.5, 0.47);
        g.rotate(-0.25);
        rr(-0.28, -0.06, 0.62, 0.12, 0.04, "#3d4338");
        rr(0.28, -0.08, 0.1, 0.16, 0.03, "#2b2f28");
        g.restore();
      } else {
        g.save();
        g.translate(0.62, 0.55);
        g.rotate(-0.6);
        rr(-0.03, -0.2, 0.06, 0.36, 0.02, "#3a2c20");
        g.restore();
      }
      break;
    }
    case "recon": {
      rr(0.14, 0.48, 0.74, 0.24, 0.07, body);
      rr(0.3, 0.32, 0.36, 0.2, 0.06, light);
      g.fillStyle = "rgba(30, 40, 60, 0.8)";
      g.fillRect(0.38, 0.36, 0.22, 0.1);
      circle(0.32, 0.75, 0.1, ink);
      circle(0.7, 0.75, 0.1, ink);
      g.fillStyle = "#999";
      g.beginPath();
      g.arc(0.32, 0.75, 0.04, 0, Math.PI * 2);
      g.arc(0.7, 0.75, 0.04, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#ffe07a";
      g.fillRect(0.8, 0.52, 0.06, 0.06);
      break;
    }
    case "tank": {
      rr(0.12, 0.62, 0.76, 0.2, 0.09, "#2c2f33");
      g.fillStyle = "#777";
      for (let i = 0; i < 4; i++) {
        g.beginPath();
        g.arc(0.24 + i * 0.17, 0.72, 0.045, 0, Math.PI * 2);
        g.fill();
      }
      rr(0.16, 0.46, 0.68, 0.2, 0.05, body);
      rr(0.62, 0.36, 0.32, 0.08, 0.03, dark);
      rr(0.32, 0.32, 0.34, 0.18, 0.07, light);
      break;
    }
    case "heavy": {
      rr(0.06, 0.6, 0.88, 0.24, 0.1, "#25282c");
      g.fillStyle = "#6d6d6d";
      for (let i = 0; i < 5; i++) {
        g.beginPath();
        g.arc(0.16 + i * 0.17, 0.72, 0.045, 0, Math.PI * 2);
        g.fill();
      }
      rr(0.1, 0.42, 0.8, 0.22, 0.05, body);
      rr(0.6, 0.29, 0.4, 0.1, 0.03, dark);
      rr(0.26, 0.24, 0.42, 0.22, 0.07, light);
      g.fillStyle = dark;
      g.fillRect(0.34, 0.3, 0.26, 0.04);
      break;
    }
    case "artillery": {
      g.save();
      g.translate(0.46, 0.56);
      g.rotate(-0.62);
      rr(-0.02, -0.06, 0.52, 0.12, 0.03, dark);
      g.restore();
      rr(0.14, 0.52, 0.56, 0.18, 0.05, body);
      circle(0.28, 0.74, 0.11, ink);
      circle(0.56, 0.74, 0.11, ink);
      g.fillStyle = "#999";
      g.beginPath();
      g.arc(0.28, 0.74, 0.04, 0, Math.PI * 2);
      g.arc(0.56, 0.74, 0.04, 0, Math.PI * 2);
      g.fill();
      rr(0.62, 0.62, 0.22, 0.08, 0.03, dark);
      break;
    }
  }
  g.restore();
}

/** A unit drawn on its own little canvas, for the build menu. */
export function unitIcon(type: UnitType, color: string, cssPx = 40): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  c.width = c.height = Math.round(cssPx * dpr);
  c.style.width = c.style.height = `${cssPx}px`;
  const g = c.getContext("2d")!;
  g.scale(cssPx * dpr, cssPx * dpr);
  drawUnit(g, type, 0, 0, color, 1, false);
  return c;
}

// ------------------------------------------------------------------ overlays

function tileFill(g: CanvasRenderingContext2D, m: MapDef, t: number, fill: string, edge: string, scale: number): void {
  const x = t % m.w;
  const y = Math.floor(t / m.w);
  g.fillStyle = fill;
  g.fillRect(x, y, 1, 1);
  g.strokeStyle = edge;
  g.lineWidth = 1 / scale;
  g.strokeRect(x + 0.5 / scale, y + 0.5 / scale, 1 - 1 / scale, 1 - 1 / scale);
}

function drawPath(g: CanvasRenderingContext2D, m: MapDef, path: number[], scale: number): void {
  const pts = path.map((t) => [(t % m.w) + 0.5, Math.floor(t / m.w) + 0.5]);
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const [w, c] of [
    [Math.max(0.22, 7 / scale), "rgba(20, 20, 40, 0.75)"],
    [Math.max(0.12, 4 / scale), "#fff4c2"],
  ] as const) {
    g.strokeStyle = c;
    g.lineWidth = w;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
  }
  const [x1, y1] = pts[pts.length - 1];
  const [x0, y0] = pts[pts.length - 2];
  const a = Math.atan2(y1 - y0, x1 - x0);
  g.fillStyle = "#fff4c2";
  g.strokeStyle = "rgba(20, 20, 40, 0.75)";
  g.lineWidth = 1.5 / scale;
  g.beginPath();
  g.moveTo(x1 + Math.cos(a) * 0.22, y1 + Math.sin(a) * 0.22);
  g.lineTo(x1 + Math.cos(a + 2.3) * 0.22, y1 + Math.sin(a + 2.3) * 0.22);
  g.lineTo(x1 + Math.cos(a - 2.3) * 0.22, y1 + Math.sin(a - 2.3) * 0.22);
  g.closePath();
  g.fill();
  g.stroke();
}

function brackets(g: CanvasRenderingContext2D, m: MapDef, t: number, color: string, scale: number, now: number): void {
  const x = t % m.w;
  const y = Math.floor(t / m.w);
  const p = 0.04 + 0.03 * Math.sin(now / 180);
  const l = 0.28;
  g.strokeStyle = color;
  g.lineWidth = Math.max(0.07, 3 / scale);
  g.lineCap = "square";
  g.beginPath();
  for (const [cx, cy, dx, dy] of [
    [x - p, y - p, 1, 1],
    [x + 1 + p, y - p, -1, 1],
    [x - p, y + 1 + p, 1, -1],
    [x + 1 + p, y + 1 + p, -1, -1],
  ]) {
    g.moveTo(cx + dx * l, cy);
    g.lineTo(cx, cy);
    g.lineTo(cx, cy + dy * l);
  }
  g.stroke();
}
