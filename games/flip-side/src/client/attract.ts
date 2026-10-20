import { randomSeed } from "@warrick/kit/shared/rng";
import { Pilot } from "../shared/ai";
import { PLAYER_COLORS, TICK_HZ } from "../shared/constants";
import { emptyView, viewOf } from "../shared/protocol";
import { TABLE } from "../shared/table";
import { EV_BUMPER, EV_SLING, Play, startPlay, stepPlay, type Rules } from "../shared/sim";
import { TableRenderer } from "./render";

/** A hard CPU playing the table behind the home screen. */
export class Attract {
  private readonly renderer: TableRenderer;
  private play!: Play;
  private pilot!: Pilot;
  private rules!: Rules;
  private color = PLAYER_COLORS[0] as string;
  private start = 0;
  private lastNow = 0;
  private readonly view = emptyView();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new TableRenderer(canvas);
    this.reset(performance.now());
  }

  resize(): void {
    this.renderer.resize();
  }

  frame(now: number): void {
    // The tab was hidden: don't fast-forward the game.
    if (now - this.lastNow > 500) this.start += now - this.lastNow;
    this.lastNow = now;
    if (this.play.over) this.reset(now);
    const target = Math.floor(((now - this.start) * TICK_HZ) / 1000);
    let steps = 0;
    while (this.play.tick < target && steps++ < 30) {
      stepPlay(this.play, this.pilot.decide(this.play, TABLE, this.rules), TABLE, this.rules);
      for (const e of this.play.events) {
        if (e.k === EV_BUMPER) this.renderer.flash(e.i);
        else if (e.k === EV_SLING) this.renderer.flash(3 + e.i);
      }
    }
    this.renderer.resize();
    this.renderer.draw(viewOf(this.play, this.view), this.color, now);
  }

  private reset(now: number): void {
    this.rules = { mode: "timed", endTick: 2 * 60 * TICK_HZ, balls: 3, seed: randomSeed() };
    this.play = startPlay(this.rules);
    this.pilot = new Pilot("hard", randomSeed());
    this.color = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
    this.renderer.reset();
    this.start = now;
    this.lastNow = now;
  }
}
