// Liar's Dice's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  /** Dice rattling in a cup. */
  roll(): void {
    for (let i = 0; i < 7; i++) tone(700 + Math.random() * 900, 0.025, 0.06, "square", 500, i * 0.045 + Math.random() * 0.02);
    noiseBurst(0.35, 2400, 0.08, "bandpass");
  },
  bid(): void {
    tone(520, 0.07, 0.08, "triangle", 600);
  },
  turn(): void {
    tone(660, 0.09, 0.12, "square");
    tone(990, 0.12, 0.12, "square", 990, 0.1);
  },
  /** A call: the cups slam up. */
  call(): void {
    noiseBurst(0.3, 700, 0.5);
    tone(150, 0.3, 0.4, "sawtooth", 60);
  },
  /** One more die counted. */
  tick(n: number): void {
    tone(500 + Math.min(n, 20) * 35, 0.05, 0.07, "square");
  },
  lose(): void {
    tone(420, 0.45, 0.2, "triangle", 140);
  },
  gain(): void {
    tone(523, 0.1, 0.12, "square");
    tone(784, 0.16, 0.12, "square", 784, 0.1);
  },
  win(): void {
    tone(523, 0.12, 0.14, "square");
    tone(659, 0.12, 0.14, "square", 659, 0.12);
    tone(784, 0.3, 0.14, "square", 784, 0.24);
  },
  click(): void {
    tone(1200, 0.03, 0.05, "square");
  },
};
