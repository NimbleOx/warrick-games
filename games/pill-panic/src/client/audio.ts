// Pill Panic's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  move(): void {
    tone(220, 0.03, 0.05, "square");
  },
  rotate(): void {
    tone(660, 0.04, 0.06, "square", 880);
  },
  land(): void {
    tone(140, 0.08, 0.14, "triangle", 70);
  },
  /** Lines popping; each step of a chain climbs higher. */
  pop(chain: number, viruses: number): void {
    const base = 520 * 2 ** ((Math.min(chain, 6) - 1) / 4);
    tone(base, 0.08, 0.13, "square");
    tone(base * 1.26, 0.08, 0.13, "square", base * 1.26, 0.06);
    tone(base * 1.5, 0.14, 0.13, "square", base * 1.5, 0.12);
    // The kit's noise bursts can't be scheduled ahead, so this one waits on a timer.
    if (viruses) setTimeout(() => noiseBurst(0.18, 2600, 0.18, "bandpass"), 50);
  },
  /** We sent an attack. */
  attack(): void {
    noiseBurst(0.3, 5000, 0.22, "highpass");
    tone(900, 0.25, 0.12, "sawtooth", 1800);
  },
  /** An attack is on its way to us. */
  warn(): void {
    tone(330, 0.1, 0.14, "square");
    tone(250, 0.16, 0.14, "square", 250, 0.11);
  },
  /** Garbage rattling into our bottle. */
  garbage(): void {
    for (let i = 0; i < 4; i++) tone(180 + i * 25, 0.05, 0.1, "square", 120, i * 0.06);
  },
  count(): void {
    tone(520, 0.12, 0.14, "square");
  },
  go(): void {
    tone(1040, 0.3, 0.16, "square");
  },
  /** Our bottle is clear. */
  clear(): void {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.16, 0.14, "square", f, i * 0.09));
  },
  /** Our bottle filled up. */
  out(): void {
    noiseBurst(0.5, 1200, 0.4);
    tone(330, 0.6, 0.22, "sawtooth", 55);
  },
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 0.14, "square", f, i * 0.12));
    tone(1047, 0.5, 0.14, "triangle", 1047, 0.5);
  },
  lose(): void {
    [392, 330, 262].forEach((f, i) => tone(f, 0.22, 0.12, "triangle", f, i * 0.18));
  },
};
