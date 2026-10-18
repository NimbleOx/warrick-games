// Double Trouble's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  slide(): void {
    tone(700, 0.025, 0.03, "triangle", 520);
  },
  /** A move that went nowhere. */
  bump(): void {
    tone(150, 0.06, 0.05, "square");
  },
  /** Tiles merged; bigger tiles ring higher, and several at once make a chord. */
  merge(best: number, count: number): void {
    const base = 260 * 2 ** (Math.min(best, 12) / 4);
    const notes = [1, 1.25, 1.5, 2].slice(0, Math.min(4, count));
    notes.forEach((m, i) => tone(base * m, 0.09, 0.09, "square", base * m, i * 0.035));
  },
  /** A rock smashed. */
  smash(): void {
    noiseBurst(0.16, 2600, 0.2, "highpass");
    tone(240, 0.08, 0.08, "square", 120);
  },
  /** Rocks are on their way to you. */
  warn(): void {
    tone(220, 0.12, 0.1, "sawtooth", 180);
    tone(220, 0.12, 0.1, "sawtooth", 180, 0.15);
  },
  /** Rocks landed on your board. */
  land(n: number): void {
    noiseBurst(0.1 + Math.min(n, 4) * 0.04, 500, 0.28);
    tone(110, 0.18, 0.14, "square", 70);
  },
  /** You sent rocks. */
  send(n: number): void {
    tone(500, 0.12 + Math.min(n, 8) * 0.025, 0.1, "sawtooth", 1400);
  },
  /** A new biggest tile. */
  best(v: number): void {
    const base = 523 * 2 ** ((Math.min(v, 12) - 7) / 6);
    [1, 1.25, 1.5, 2].forEach((m, i) => tone(base * m, 0.14, 0.12, "square", base * m, i * 0.07));
  },
  /** You filled up. */
  die(): void {
    noiseBurst(0.6, 1200, 0.4);
    tone(330, 0.7, 0.22, "sawtooth", 50);
  },
  /** You knocked someone out. */
  ko(): void {
    tone(1400, 0.12, 0.16, "square", 500);
    tone(1800, 0.2, 0.14, "square", 900, 0.1);
  },
  /** Someone else went out. */
  thud(): void {
    noiseBurst(0.18, 700, 0.16);
  },
  count(): void {
    tone(520, 0.12, 0.14, "square");
  },
  go(): void {
    tone(1040, 0.3, 0.16, "square");
  },
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 0.14, "square", f, i * 0.12));
  },
  lose(): void {
    [392, 330, 262].forEach((f, i) => tone(f, 0.2, 0.12, "triangle", f, i * 0.14));
  },
};
