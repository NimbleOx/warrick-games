import { DX, DY, type Board } from "../shared/board";
import { hexToRgb, mix, type RGB } from "@warrick/kit/client/color";
import { MAX_PLAYERS } from "@warrick/kit/shared/constants";

/** How a slot looks on the board. */
export interface Look {
  color: string;
  name: string;
}

export interface Scene {
  board: Board;
  /** By slot; null for an empty slot. */
  looks: (Look | null)[];
  /** The viewer's slot, or -1 when watching. */
  me: number;
  /** Show name tags over heads. */
  names?: boolean;
}

/** Smallest cell size (CSS px) at which the whole board is shown; below it the camera follows you. */
const MIN_FIT_CELL = 7;
const FOLLOW_CELL = 12;

const BG = "#0b0d17";
const GROUND_A = hexToRgb("#141932");
const GROUND_B = hexToRgb("#171d39");

/**
 * Draws the board on a canvas. The grid is painted into an offscreen image at
 * one pixel per cell, then drawn scaled up with smoothing off, so a full
 * repaint costs one pass over the cells and one drawImage.
 */
export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  private tile = document.createElement("canvas");
  private tileCtx = this.tile.getContext("2d")!;
  private img: ImageData | null = null;
  private pixels: Uint32Array | null = null;
  private landPx = new Uint32Array(MAX_PLAYERS * 2);
  private trailPx = new Uint32Array(MAX_PLAYERS);
  private groundPx = [pack(GROUND_A), pack(GROUND_B)];
  private paletteKey = "";
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  /** Camera center in cells, eased toward the target each frame. */
  private cam = { x: -1, y: -1 };
  private lastDraw = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Size the canvas to its box. */
  resize(cssW: number, cssH: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(cssW));
    const h = Math.max(1, Math.floor(cssH));
    // Sizing a canvas clears it and its buffers, even to the size it already is.
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) return;
    this.dpr = dpr;
    this.cssW = w;
    this.cssH = h;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
  }

  /** Whether a board this size fits the canvas at a playable cell size. */
  fits(w: number, h: number): boolean {
    return Math.min(this.cssW / w, this.cssH / h) >= MIN_FIT_CELL;
  }

  /** Repaint the grid image. Call after the board changes. */
  paint(scene: Scene): void {
    const b = scene.board;
    if (!this.img || this.img.width !== b.w || this.img.height !== b.h) {
      this.tile.width = b.w;
      this.tile.height = b.h;
      this.img = this.tileCtx.createImageData(b.w, b.h);
      this.pixels = new Uint32Array(this.img.data.buffer);
    }
    this.setPalette(scene.looks);
    const px = this.pixels!;
    const { owner, trail, w } = b;
    for (let c = 0, y = 0; y < b.h; y++) {
      for (let x = 0; x < w; x++, c++) {
        const odd = (x + y) & 1;
        const t = trail[c];
        const o = owner[c];
        px[c] = t ? this.trailPx[t - 1] : o ? this.landPx[(o - 1) * 2 + odd] : this.groundPx[odd];
      }
    }
    this.tileCtx.putImageData(this.img!, 0, 0);
  }

  draw(scene: Scene, now: number): void {
    const { ctx, dpr } = this;
    const b = scene.board;
    const dt = this.lastDraw ? Math.min(0.1, (now - this.lastDraw) / 1000) : 1;
    this.lastDraw = now;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.img) return;

    // Cell size in device pixels, kept whole so every cell is the same size.
    const fit = this.fits(b.w, b.h);
    const cellCss = fit ? Math.min(this.cssW / b.w, this.cssH / b.h) : FOLLOW_CELL;
    const cell = Math.max(1, Math.floor(cellCss * dpr));
    const viewW = this.canvas.width / cell;
    const viewH = this.canvas.height / cell;

    let ox: number;
    let oy: number;
    if (fit) {
      ox = Math.floor((this.canvas.width - b.w * cell) / 2);
      oy = Math.floor((this.canvas.height - b.h * cell) / 2);
      this.cam = { x: -1, y: -1 };
    } else {
      const target = this.focus(scene);
      if (this.cam.x < 0) this.cam = { ...target };
      const ease = 1 - Math.exp(-dt * 7);
      this.cam.x += (target.x - this.cam.x) * ease;
      this.cam.y += (target.y - this.cam.y) * ease;
      // Keep your head in the middle, even near the edge: the dark beyond the red line is the wall.
      const cx = viewW >= b.w ? b.w / 2 : this.cam.x;
      const cy = viewH >= b.h ? b.h / 2 : this.cam.y;
      ox = Math.round(this.canvas.width / 2 - cx * cell);
      oy = Math.round(this.canvas.height / 2 - cy * cell);
    }

    // The grid.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.tile, ox, oy, b.w * cell, b.h * cell);

    // The edge of the board is deadly; make it obvious.
    ctx.strokeStyle = "rgb(255 77 94 / 0.55)";
    ctx.lineWidth = Math.max(2, dpr * 2);
    ctx.strokeRect(ox - ctx.lineWidth / 2, oy - ctx.lineWidth / 2, b.w * cell + ctx.lineWidth, b.h * cell + ctx.lineWidth);

    this.drawHeads(scene, ox, oy, cell, now);
    if (!fit) this.drawMinimap(scene, ox, oy, cell);
  }

  private drawHeads(scene: Scene, ox: number, oy: number, cell: number, now: number): void {
    const { ctx, dpr } = this;
    const b = scene.board;
    const showNames = scene.names !== false && cell >= 6 * dpr;
    const order = b.heads.map((_, s) => s).sort((a, c) => (a === scene.me ? 1 : 0) - (c === scene.me ? 1 : 0));
    for (const s of order) {
      const h = b.heads[s];
      const look = scene.looks[s];
      if (!h.alive || h.cell < 0 || !look) continue;
      const x = ox + (h.cell % b.w) * cell;
      const y = oy + Math.floor(h.cell / b.w) * cell;
      const pad = Math.max(1, Math.round(cell * 0.12));
      const size = cell + pad * 2;

      if (s === scene.me) {
        // A soft pulse around your own head so you can always find it.
        const pulse = 0.5 + 0.5 * Math.sin(now / 160);
        ctx.strokeStyle = `rgb(255 255 255 / ${0.25 + pulse * 0.3})`;
        ctx.lineWidth = Math.max(1, dpr * 1.5);
        ctx.beginPath();
        ctx.arc(x + cell / 2, y + cell / 2, cell * (1.25 + pulse * 0.35), 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = look.color;
      ctx.fillRect(x - pad, y - pad, size, size);
      ctx.lineWidth = Math.max(1, Math.round(cell * 0.14));
      ctx.strokeStyle = s === scene.me ? "#ffffff" : "rgb(0 0 0 / 0.55)";
      ctx.strokeRect(x - pad + ctx.lineWidth / 2, y - pad + ctx.lineWidth / 2, size - ctx.lineWidth, size - ctx.lineWidth);

      // A dark nub on the leading edge shows which way it's going.
      if (cell >= 5 * dpr) {
        const n = Math.max(1, Math.round(cell * 0.28));
        const cx = x + cell / 2 + DX[h.dir] * (cell / 2 - n / 2);
        const cy = y + cell / 2 + DY[h.dir] * (cell / 2 - n / 2);
        ctx.fillStyle = "rgb(0 0 0 / 0.6)";
        ctx.fillRect(Math.round(cx - n / 2), Math.round(cy - n / 2), n, n);
      }

      if (showNames) {
        const fontPx = Math.round(11 * dpr);
        ctx.font = `600 ${fontPx}px "IBM Plex Mono", ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        const label = s === scene.me ? "you" : look.name;
        const tx = x + cell / 2;
        const ty = y - pad - 3 * dpr;
        const tw = ctx.measureText(label).width + 8 * dpr;
        ctx.fillStyle = "rgb(8 10 20 / 0.7)";
        ctx.fillRect(tx - tw / 2, ty - fontPx - 2 * dpr, tw, fontPx + 3 * dpr);
        ctx.fillStyle = s === scene.me ? "#ffffff" : look.color;
        ctx.fillText(label, tx, ty);
      }
    }
  }

  private drawMinimap(scene: Scene, ox: number, oy: number, cell: number): void {
    const { ctx, dpr } = this;
    const b = scene.board;
    const scale = Math.max(1, Math.floor((Math.min(this.canvas.width * 0.3, 150 * dpr) / b.w) * 10) / 10);
    const mw = b.w * scale;
    const mh = b.h * scale;
    const mx = this.canvas.width - mw - 8 * dpr;
    const my = 8 * dpr;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = BG;
    ctx.fillRect(mx - 3 * dpr, my - 3 * dpr, mw + 6 * dpr, mh + 6 * dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.tile, mx, my, mw, mh);
    ctx.globalAlpha = 1;
    // The part of the board on screen.
    const x0 = Math.max(0, -ox / cell);
    const y0 = Math.max(0, -oy / cell);
    const x1 = Math.min(b.w, (this.canvas.width - ox) / cell);
    const y1 = Math.min(b.h, (this.canvas.height - oy) / cell);
    ctx.strokeStyle = "rgb(255 255 255 / 0.8)";
    ctx.lineWidth = dpr;
    ctx.strokeRect(mx + x0 * scale, my + y0 * scale, (x1 - x0) * scale, (y1 - y0) * scale);
    for (let s = 0; s < MAX_PLAYERS; s++) {
      const h = b.heads[s];
      const look = scene.looks[s];
      if (!h.alive || !look) continue;
      const d = Math.max(3 * dpr, scale * 2);
      ctx.fillStyle = s === scene.me ? "#ffffff" : look.color;
      ctx.fillRect(mx + (h.cell % b.w) * scale - d / 2, my + Math.floor(h.cell / b.w) * scale - d / 2, d, d);
    }
  }

  /** Where the camera wants to be: on your head, or the middle of your land, or the board. */
  private focus(scene: Scene): { x: number; y: number } {
    const b = scene.board;
    const h = scene.me >= 0 ? b.heads[scene.me] : null;
    if (h?.alive && h.cell >= 0) return { x: (h.cell % b.w) + 0.5, y: Math.floor(h.cell / b.w) + 0.5 };
    if (this.cam.x >= 0) return { ...this.cam };
    return { x: b.w / 2, y: b.h / 2 };
  }

  private setPalette(looks: (Look | null)[]): void {
    const key = looks.map((l) => l?.color ?? "").join();
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    for (let s = 0; s < MAX_PLAYERS; s++) {
      const c = hexToRgb(looks[s]?.color ?? "#777777");
      this.landPx[s * 2] = pack(mix(c, GROUND_A, 0.42));
      this.landPx[s * 2 + 1] = pack(mix(c, GROUND_B, 0.36));
      this.trailPx[s] = pack(mix(c, [255, 255, 255], 0.38));
    }
  }
}

/** RGB channels, rounded to bytes, as one opaque little-endian 32-bit pixel. */
function pack(c: RGB): number {
  const [r, g, b] = c.map(Math.round);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}
