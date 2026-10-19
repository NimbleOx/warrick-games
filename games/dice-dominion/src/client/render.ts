import { CORNERS, cellCenter, gridExtent, neighbours } from "../shared/hex";
import type { HexMap } from "../shared/map";

/** What the board looks like right now (during an animation it lags the server's state). */
export interface Board {
  owner: number[];
  dice: number[];
}

export interface Overlay {
  /** Each seat's colour. */
  colors: string[];
  selected: number;
  /** Territories the selected stack can attack, with the chance of winning. */
  targets: Map<number, number>;
  hover: number;
  /** An attack being rolled: an arrow, then the result once it's revealed. */
  attack: { from: number; to: number; won: boolean | null } | null;
  /** Territories lit up by a landing die or a capture: territory → when (performance.now()). */
  flash: Map<number, number>;
  /** The seat whose turn it is, to lift its territories a little; -1 for none. */
  active: number;
}

const SEA = "#0d1a33";
const SEA_EDGE = "#1c3157";
const BORDER = "#070b16";
const FLASH_MS = 380;

/** A dice stack drawn once into a canvas of its own, and the device pixel its (x, y) falls on. */
interface Sprite {
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
}

/**
 * Draws a game's hex map: each territory filled with its owner's colour, borders where
 * territories meet, and its dice stacked on the cell farthest from its edge. The geometry is
 * built once per map in units of the hex radius; drawing scales it to fit the canvas.
 */
export class MapView {
  readonly ctx: CanvasRenderingContext2D;
  map: HexMap | null = null;
  /** Hex radius in CSS pixels, and the map's top-left corner on the canvas. */
  scale = 10;
  private ox = 0;
  private oy = 0;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  private extent = { width: 1, height: 1 };
  private fills: Path2D[] = [];
  private edges: Path2D[] = [];
  private borders = new Path2D();
  private coast = new Path2D();
  private anchors: { x: number; y: number }[] = [];
  /** Territories by their dice stack's height on screen, so lower stacks draw over higher ones. */
  private stackOrder: number[] = [];
  /**
   * Each stack drawn once, by colour and count, and copied onto the map from then on: a full
   * map has a few thousand faces, and CPU turns redraw it every frame. Emptied when the scale changes.
   */
  private stacks = new Map<string, Sprite>();

  constructor(
    readonly canvas: HTMLCanvasElement,
    /** Fill the canvas (cropping the map) instead of fitting the whole map in it. */
    private cover = false,
  ) {
    this.ctx = canvas.getContext("2d")!;
    // The counts beside small stacks are text: draw them again in the web font once it arrives.
    document.fonts?.addEventListener("loadingdone", () => this.stacks.clear());
  }

  setMap(map: HexMap): void {
    if (this.map?.id === map.id && this.map.cells.length === map.cells.length) return;
    this.map = map;
    const { w, h, cells } = map;
    const count = map.adj.length;
    this.extent = gridExtent(w, h);
    this.fills = Array.from({ length: count }, () => new Path2D());
    this.edges = Array.from({ length: count }, () => new Path2D());
    this.borders = new Path2D();
    this.coast = new Path2D();
    for (let i = 0; i < cells.length; i++) {
      const t = cells[i];
      if (t < 0) continue;
      const c = cellCenter(w, i);
      const fill = this.fills[t];
      fill.moveTo(c.x + CORNERS[0].x * 1.02, c.y + CORNERS[0].y * 1.02);
      for (let k = 1; k < 6; k++) fill.lineTo(c.x + CORNERS[k].x * 1.02, c.y + CORNERS[k].y * 1.02);
      fill.closePath();
      neighbours(w, h, i).forEach((nb, k) => {
        const u = nb < 0 ? -1 : cells[nb];
        if (u === t) return;
        const a = CORNERS[k];
        const b = CORNERS[(k + 1) % 6];
        this.edges[t].moveTo(c.x + a.x, c.y + a.y);
        this.edges[t].lineTo(c.x + b.x, c.y + b.y);
        // Each shared border once; coast edges separately.
        const path = u < 0 ? this.coast : u > t ? this.borders : null;
        if (path) {
          path.moveTo(c.x + a.x, c.y + a.y);
          path.lineTo(c.x + b.x, c.y + b.y);
        }
      });
    }
    this.anchors = map.anchor.map((cell) => cellCenter(w, cell));
    this.stackOrder = this.anchors.map((_, t) => t).sort((a, b) => this.anchors[a].y - this.anchors[b].y);
    this.layout();
  }

  /** Size the canvas in CSS pixels. */
  resize(cssW: number, cssH: number): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cssW = Math.max(1, Math.round(cssW));
    this.cssH = Math.max(1, Math.round(cssH));
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.layout();
  }

  /** The map's width / height, for sizing the canvas around it. */
  get aspect(): number {
    return this.extent.width / this.extent.height;
  }

  private layout(): void {
    const pad = 0.6;
    const W = this.extent.width + pad * 2;
    const H = this.extent.height + pad * 2;
    const fit = this.cover ? Math.max : Math.min;
    this.scale = fit(this.cssW / W, this.cssH / H);
    this.ox = (this.cssW - this.extent.width * this.scale) / 2;
    this.oy = (this.cssH - this.extent.height * this.scale) / 2;
    this.stacks.clear();
  }

  /** The territory under a point on the page, or -1. */
  hit(clientX: number, clientY: number): number {
    const map = this.map;
    if (!map) return -1;
    const r = this.canvas.getBoundingClientRect();
    const x = (clientX - r.left - this.ox) / this.scale;
    const y = (clientY - r.top - this.oy) / this.scale;
    let best = -1;
    let bestD = 1.1;
    const row = Math.round((y - 1) / 1.5);
    for (let rr = row - 1; rr <= row + 1; rr++) {
      if (rr < 0 || rr >= map.h) continue;
      for (let cc = 0; cc < map.w; cc++) {
        const cell = rr * map.w + cc;
        const c = cellCenter(map.w, cell);
        const d = Math.hypot(c.x - x, c.y - y);
        if (d < bestD) {
          bestD = d;
          best = cell;
        }
      }
    }
    return best < 0 ? -1 : map.cells[best];
  }

  draw(board: Board, o: Overlay, now: number): void {
    const { ctx, map } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = SEA;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    if (!map || board.owner.length !== map.adj.length) return;

    const s = this.scale;
    ctx.setTransform(s * this.dpr, 0, 0, s * this.dpr, this.ox * this.dpr, this.oy * this.dpr);
    const px = 1 / s; // one CSS pixel in map units

    // A soft glow around the coast, then the land.
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = SEA_EDGE;
    ctx.lineWidth = Math.max(0.5, 5 * px);
    ctx.stroke(this.coast);

    for (let t = 0; t < this.fills.length; t++) {
      const color = o.colors[board.owner[t]] ?? "#777777";
      let amount = o.active >= 0 && board.owner[t] !== o.active ? 0.56 : 0.66;
      if (t === o.selected) amount = 0.9;
      else if (o.targets.has(t)) amount = t === o.hover ? 0.84 : 0.72;
      else if (t === o.hover) amount += 0.1;
      ctx.fillStyle = mix(color, "#0a1022", amount);
      ctx.fill(this.fills[t]);
      const lit = o.flash.get(t);
      if (lit !== undefined && now - lit < FLASH_MS) {
        ctx.fillStyle = `rgb(255 255 255 / ${0.45 * (1 - (now - lit) / FLASH_MS)})`;
        ctx.fill(this.fills[t]);
      }
    }

    ctx.strokeStyle = BORDER;
    ctx.lineWidth = Math.max(0.1, 2 * px);
    ctx.stroke(this.borders);
    ctx.lineWidth = Math.max(0.12, 2.5 * px);
    ctx.stroke(this.coast);

    // Targets pulse; the selected stack gets a bright outline.
    if (o.targets.size) {
      const pulse = 0.55 + 0.45 * Math.sin(now / 160);
      ctx.strokeStyle = `rgb(255 210 63 / ${pulse})`;
      ctx.lineWidth = Math.max(0.15, 3 * px);
      for (const t of o.targets.keys()) ctx.stroke(this.edges[t]);
    }
    if (o.selected >= 0) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = Math.max(0.18, 3.5 * px);
      ctx.stroke(this.edges[o.selected]);
    }
    if (o.attack) {
      ctx.strokeStyle = o.attack.won === false ? "#ff4d5e" : "#ffffff";
      ctx.lineWidth = Math.max(0.18, 3.5 * px);
      ctx.stroke(this.edges[o.attack.from]);
      ctx.stroke(this.edges[o.attack.to]);
    }

    // Dice stacks, back to front, on whole device pixels so the copies stay sharp.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const t of this.stackOrder) {
      const sprite = this.stack(board.dice[t], o.colors[board.owner[t]] ?? "#777777");
      if (!sprite) continue;
      const p = this.toScreen(this.anchors[t]);
      ctx.drawImage(sprite.ctx.canvas, Math.round(p.x * this.dpr) - sprite.x, Math.round(p.y * this.dpr) - sprite.y);
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    if (o.attack) this.drawArrow(o.attack.from, o.attack.to, o.attack.won);
    for (const [t, chance] of o.targets) this.drawOdds(t, chance, t === o.hover);
  }

  /** A stack of `n` dice at the current scale, from the cache or drawn now. */
  private stack(n: number, color: string): Sprite | null {
    if (n <= 0) return null;
    const key = `${color} ${n}`;
    let sprite = this.stacks.get(key);
    // A 2D canvas can lose its pixels (Chrome drops them from background tabs to save memory).
    if (sprite && !sprite.ctx.isContextLost?.()) return sprite;
    const r = this.scale;
    const dpr = this.dpr;
    const d = dieSize(r);
    const label = r < 9 ? labelSize(d) : 0;
    // Room for 8 dice, their outlines and the count beside them, rounded out to device pixels.
    const x = Math.ceil((d + 2) * dpr);
    const y = Math.ceil((2.5 * d + 2) * dpr);
    const canvas = document.createElement("canvas");
    canvas.width = x + Math.ceil((d + 2 + label) * dpr);
    canvas.height = y + Math.ceil((d + 2 + label) * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStack(ctx, x / dpr, y / dpr, n, color, r);
    // Colours only change in the lobby, but don't let changing them grow the cache for ever.
    if (this.stacks.size > 200) this.stacks.clear();
    sprite = { ctx, x, y };
    this.stacks.set(key, sprite);
    return sprite;
  }

  private toScreen(p: { x: number; y: number }): { x: number; y: number } {
    return { x: this.ox + p.x * this.scale, y: this.oy + p.y * this.scale };
  }

  private drawArrow(from: number, to: number, won: boolean | null): void {
    const ctx = this.ctx;
    const a = this.toScreen(this.anchors[from]);
    const b = this.toScreen(this.anchors[to]);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const head = Math.max(8, this.scale * 1.4);
    const ex = b.x - ux * head * 0.4;
    const ey = b.y - uy * head * 0.4;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgb(0 0 0 / 0.6)";
    ctx.lineWidth = Math.max(5, this.scale * 0.7);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.strokeStyle = won === false ? "#ff4d5e" : "#ffffff";
    ctx.lineWidth = Math.max(2.5, this.scale * 0.35);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - ux * head - uy * head * 0.6, b.y - uy * head + ux * head * 0.6);
    ctx.lineTo(b.x - ux * head + uy * head * 0.6, b.y - uy * head - ux * head * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawOdds(t: number, chance: number, hover: boolean): void {
    const ctx = this.ctx;
    const p = this.toScreen(this.anchors[t]);
    // Never promise a sure thing: 7 dice against 3 still lose now and then.
    const pct = Math.round(chance * 100);
    const text = chance >= 1 ? "100%" : pct >= 100 ? ">99%" : chance > 0 && pct <= 0 ? "<1%" : `${pct}%`;
    const size = Math.max(10, Math.min(14, this.scale * 1.1));
    ctx.font = `600 ${size}px "IBM Plex Mono", ui-monospace, monospace`;
    const w = ctx.measureText(text).width + 8;
    const h = size + 5;
    const x = p.x - w / 2;
    const y = p.y + this.scale * 0.55;
    ctx.fillStyle = hover ? "#ffd23f" : "rgb(8 10 20 / 0.82)";
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.fill();
    ctx.fillStyle = hover ? "#1a1203" : chance >= 0.5 ? "#9dffa0" : "#ffb0b8";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, p.x, y + h / 2 + 0.5);
  }
}

/**
 * A stack of dice standing on (x, y): up to four in a column, the rest in a second column
 * behind it. `r` is the hex radius in pixels; small maps get bigger dice.
 */
export function drawStack(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, color: string, r: number): void {
  if (n <= 0) return;
  const d = dieSize(r);
  const step = d * 0.5;
  const top = mix(color, "#ffffff", 0.55);
  const left = color;
  const right = mix(color, "#000000", 0.62);
  const outline = Math.max(0.8, d / 16);
  const column = (cx: number, by: number, count: number) => {
    for (let i = 0; i < count; i++) cube(ctx, cx, by - i * step, d, top, left, right, outline);
  };
  const base = y - d * 0.4;
  if (n <= 4) column(x, base, n);
  else {
    column(x + d * 0.3, base - d * 0.18, n - 4);
    column(x - d * 0.3, base + d * 0.12, 4);
  }
  // On small maps the cubes are hard to count, so say how many.
  if (r < 9) {
    const size = labelSize(d);
    ctx.font = `700 ${size}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgb(0 0 0 / 0.85)";
    const tx = x + d * (n > 4 ? 0.95 : 0.75);
    const ty = y + d * 0.2;
    ctx.strokeText(String(n), tx, ty);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(String(n), tx, ty);
  }
}

/** A die's width in pixels, for a hex radius of `r` pixels. */
const dieSize = (r: number): number => Math.max(6, Math.min(26, r * 1.3));
/** The font size of the count beside a stack of `d`-pixel dice. */
const labelSize = (d: number): number => Math.max(9, Math.round(d * 0.95));

/** One die: an isometric cube whose top face is centred on (x, y). */
function cube(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  d: number,
  top: string,
  left: string,
  right: string,
  outline: number,
): void {
  const hw = d / 2;
  const q = d / 4;
  const side = d / 2;
  ctx.lineJoin = "round";
  ctx.lineWidth = outline;
  ctx.strokeStyle = "rgb(0 0 0 / 0.8)";
  // Left face, right face, top face.
  ctx.beginPath();
  ctx.moveTo(x - hw, y);
  ctx.lineTo(x, y + q);
  ctx.lineTo(x, y + q + side);
  ctx.lineTo(x - hw, y + side);
  ctx.closePath();
  ctx.fillStyle = left;
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y + q);
  ctx.lineTo(x + hw, y);
  ctx.lineTo(x + hw, y + side);
  ctx.lineTo(x, y + q + side);
  ctx.closePath();
  ctx.fillStyle = right;
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - q);
  ctx.lineTo(x + hw, y);
  ctx.lineTo(x, y + q);
  ctx.lineTo(x - hw, y);
  ctx.closePath();
  ctx.fillStyle = top;
  ctx.fill();
  ctx.stroke();
  if (d >= 9) {
    ctx.fillStyle = "rgb(20 20 30 / 0.75)";
    ctx.beginPath();
    ctx.ellipse(x, y, d / 9, d / 18, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Mix two #rrggbb colours: `amount` of the first. */
export function mix(a: string, b: string, amount: number): string {
  const pa = parse(a);
  const pb = parse(b);
  const c = pa.map((v, i) => Math.round(v * amount + pb[i] * (1 - amount)));
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
}

const parsed = new Map<string, number[]>();
function parse(hex: string): number[] {
  let v = parsed.get(hex);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    parsed.set(hex, v);
  }
  return v;
}
