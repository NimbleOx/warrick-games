// Dust Up's sounds, built on the kit's synthesized-sound core (which also does mute): short
// effects, and an engine that keeps running while you ride.
import { audioOut, noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  count(): void {
    tone(440, 0.12, 0.12, "square");
  },
  go(): void {
    tone(880, 0.32, 0.14, "square");
    tone(1320, 0.32, 0.07, "square");
  },
  checkpoint(): void {
    tone(988, 0.08, 0.08, "triangle");
    tone(1319, 0.14, 0.08, "triangle", 1319, 0.07);
  },
  /** A hard landing: louder the harder it was (0 to 1). */
  land(hard: number): void {
    noiseBurst(0.12 + hard * 0.12, 300 + hard * 300, 0.12 + hard * 0.3);
  },
  crash(): void {
    noiseBurst(0.6, 1800, 0.45);
    tone(160, 0.35, 0.18, "sawtooth", 50);
    tone(520, 0.08, 0.06, "square", 260, 0.05);
  },
  finish(): void {
    [659, 784, 988, 1319].forEach((f, i) => tone(f, 0.14, 0.11, "square", f, i * 0.09));
  },
  win(): void {
    [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, 0.16, 0.12, "square", f, i * 0.11));
  },
  click(): void {
    tone(1200, 0.03, 0.05, "square");
  },
};

/**
 * The engine: a sawtooth and a square an octave apart through a lowpass, pitched by how fast the
 * rear wheel spins, louder and brighter on the gas. It fades out when you stop riding.
 */
export class Engine {
  private nodes: { osc: OscillatorNode; sub: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null = null;

  /** `rpm` from 0 (idle) to about 1 (top speed); `gas` 0 or 1; `on` false to fade it out. */
  set(rpm: number, gas: number, on: boolean): void {
    const out = audioOut();
    if (!out || out.ctx.state !== "running") return;
    const { ctx } = out;
    if (!this.nodes) {
      if (!on) return;
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      const sub = ctx.createOscillator();
      sub.type = "square";
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 4;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filter);
      sub.connect(filter);
      filter.connect(gain).connect(out.out);
      osc.start();
      sub.start();
      this.nodes = { osc, sub, filter, gain };
    }
    const n = this.nodes;
    const t = ctx.currentTime;
    const f = 38 + Math.min(1.2, rpm) * 110 + gas * 8;
    n.osc.frequency.setTargetAtTime(f, t, 0.04);
    n.sub.frequency.setTargetAtTime(f / 2, t, 0.04);
    n.filter.frequency.setTargetAtTime(280 + gas * 900 + rpm * 500, t, 0.05);
    n.gain.gain.setTargetAtTime(on ? 0.045 + gas * 0.05 : 0, t, on ? 0.05 : 0.15);
  }

  stop(): void {
    this.set(0, 0, false);
  }
}
