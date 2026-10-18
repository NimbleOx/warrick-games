// Boom Room's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  place(): void {
    tone(220, 0.08, 0.35, "triangle", 110);
    noiseBurst(0.05, 1800, 0.15);
  },
  boom(cells: number): void {
    const size = Math.min(1, cells / 18);
    noiseBurst(0.35 + size * 0.6, 1100 + size * 500, 0.45 + size * 0.4);
    tone(110, 0.25 + size * 0.4, 0.35 + size * 0.3, "sine", 35);
  },
  pickup(): void {
    tone(660, 0.07, 0.12, "square", 660);
    tone(880, 0.07, 0.12, "square", 880, 0.06);
    tone(1320, 0.1, 0.12, "square", 1320, 0.12);
  },
  curse(): void {
    tone(300, 0.35, 0.15, "sawtooth", 140);
    tone(310, 0.35, 0.1, "sawtooth", 145, 0.05);
  },
  kick(): void {
    tone(140, 0.08, 0.35, "square", 60);
    noiseBurst(0.08, 900, 0.2);
  },
  die(): void {
    tone(700, 0.5, 0.2, "square", 90);
    noiseBurst(0.3, 1400, 0.2, "bandpass");
  },
  count(): void {
    tone(520, 0.12, 0.14, "square");
  },
  go(): void {
    tone(1040, 0.3, 0.16, "square", 1040);
  },
  hurry(): void {
    for (let i = 0; i < 4; i++) tone(i % 2 ? 660 : 880, 0.14, 0.14, "square", i % 2 ? 660 : 880, i * 0.16);
  },
  drop(): void {
    tone(90, 0.12, 0.3, "triangle", 40);
  },
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 0.13, "square", f, i * 0.12));
  },
  click(): void {
    tone(1200, 0.03, 0.05, "square");
  },
};
