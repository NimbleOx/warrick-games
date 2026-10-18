// Stack Attack's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  shift(): void {
    tone(900, 0.02, 0.035, "square");
  },
  turn(): void {
    tone(640, 0.04, 0.05, "square", 820);
  },
  hold(): void {
    tone(520, 0.06, 0.07, "triangle", 390);
  },
  fail(): void {
    tone(160, 0.05, 0.05, "square");
  },
  land(): void {
    noiseBurst(0.05, 900, 0.08);
  },
  lock(): void {
    noiseBurst(0.07, 1300, 0.14);
    tone(180, 0.06, 0.08, "triangle", 120);
  },
  /** A clear; bigger ones climb higher. */
  clear(lines: number, special: boolean): void {
    const base = special ? 660 : 440 + lines * 60;
    const notes = special ? [1, 1.25, 1.5, 2] : [1, 1.25, 1.5].slice(0, Math.max(1, lines));
    notes.forEach((m, i) => tone(base * m, 0.1, 0.13, "square", base * m, i * 0.06));
    noiseBurst(0.18, 5000, 0.07, "highpass");
  },
  /** Garbage is on its way to you. */
  warn(): void {
    tone(220, 0.12, 0.12, "sawtooth", 180);
    tone(220, 0.12, 0.12, "sawtooth", 180, 0.15);
  },
  /** Garbage rose into your board. */
  rise(lines: number): void {
    noiseBurst(0.12 + Math.min(lines, 8) * 0.03, 500, 0.3);
    tone(110, 0.2, 0.15, "square", 70);
  },
  /** You sent garbage. */
  send(lines: number): void {
    tone(500, 0.12 + Math.min(lines, 10) * 0.02, 0.1, "sawtooth", 1400);
  },
  /** You topped out. */
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
};
