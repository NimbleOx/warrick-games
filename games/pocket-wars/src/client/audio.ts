// Pocket Wars' sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  select(): void {
    tone(880, 0.05, 0.07, "square");
  },
  step(): void {
    tone(320, 0.03, 0.04, "triangle", 260);
  },
  cancel(): void {
    tone(500, 0.06, 0.06, "square", 300);
  },
  shot(heavy: boolean): void {
    noiseBurst(heavy ? 0.32 : 0.16, heavy ? 1400 : 2600, heavy ? 0.5 : 0.32);
    tone(heavy ? 120 : 200, 0.15, 0.3, "triangle", 50);
  },
  boom(): void {
    noiseBurst(0.6, 900, 0.6);
    tone(80, 0.5, 0.45, "sine", 30);
  },
  capture(done: boolean): void {
    tone(523, 0.09, 0.1, "square");
    tone(659, 0.09, 0.1, "square", 659, 0.09);
    if (done) tone(784, 0.2, 0.12, "square", 784, 0.18);
  },
  build(): void {
    tone(260, 0.06, 0.1, "square", 390);
    tone(390, 0.08, 0.1, "square", 520, 0.07);
  },
  turn(): void {
    tone(660, 0.09, 0.12, "square");
    tone(990, 0.14, 0.12, "square", 990, 0.1);
  },
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 0.12, "square", f, i * 0.13));
  },
};
