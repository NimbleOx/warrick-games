import { cpuSteer } from "../shared/ai";
import { PLAYER_COLORS, TICK_MS } from "../shared/constants";
import type { CpuLevel } from "../shared/protocol";
import { mulberry32, randomSeed } from "../shared/rng";
import { Round, configFor } from "../shared/sim";
import { Renderer, type HeadStyle } from "./render";

const LEVELS: CpuLevel[] = ["hard", "normal", "hard", "easy", "normal"];
const PAUSE_MS = 1800;

/** The home screen's backdrop: CPU players having a round of their own, forever. */
export class Attract {
  private renderer: Renderer;
  private round: Round | null = null;
  private styles: HeadStyle[] = [];
  private rng = mulberry32(randomSeed());
  private clock = 0;
  private last = 0;
  private overAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
  }

  resize(): void {
    this.renderer.resize(window.innerWidth);
  }

  frame(now: number): void {
    if (!this.round || (this.overAt && now - this.overAt > PAUSE_MS)) this.restart(now);
    const round = this.round!;
    const dt = Math.min(100, now - this.last);
    this.last = now;
    this.clock += dt / TICK_MS;
    while (this.clock >= 1 && !round.over) {
      this.clock -= 1;
      round.heads.forEach((h, i) => {
        if (!h.alive) return;
        const s = cpuSteer(round, i, LEVELS[i], this.rng);
        if (s !== null) round.setSteer(i, s);
      });
      for (const d of round.step()) {
        const h = round.heads[d.slot];
        this.renderer.crash(h.x, h.y, this.styles[d.slot].color);
      }
      this.renderer.afterStep(round, this.styles);
    }
    if (round.over && !this.overAt) this.overAt = now;
    this.renderer.draw(round, { styles: this.styles, alpha: round.over ? 1 : this.clock, labels: false, predicted: null });
  }

  private restart(now: number): void {
    const ids = LEVELS.map((_, i) => `cpu${i}`);
    this.round = new Round({ cfg: configFor("classic"), seed: randomSeed(), ids });
    this.styles = ids.map((id, i) => ({ name: id, color: PLAYER_COLORS[(i * 3) % PLAYER_COLORS.length], you: false }));
    this.renderer.reset(this.round);
    this.resize();
    this.clock = 0;
    this.last = now;
    this.overAt = 0;
  }
}
