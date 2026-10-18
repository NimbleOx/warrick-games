// Dice Dominion's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  /** Dice rattling in a cup. */
  roll(): void {
    for (let i = 0; i < 4; i++) setTimeout(() => noiseBurst(0.04, 2600 + Math.random() * 1800, 0.22, "bandpass"), i * 55);
  },
  win(): void {
    tone(440, 0.08, 0.14, "square", 440);
    tone(660, 0.14, 0.14, "square", 880, 0.08);
  },
  lose(): void {
    tone(300, 0.22, 0.16, "triangle", 120);
  },
  drop(): void {
    tone(880 + Math.random() * 220, 0.035, 0.07, "sine");
  },
  turn(): void {
    tone(660, 0.09, 0.12, "square");
    tone(990, 0.12, 0.12, "square", 990, 0.1);
  },
  knockout(): void {
    noiseBurst(0.6, 700, 0.5);
    tone(110, 0.5, 0.35, "sine", 40);
  },
  victory(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 0.13, "square", f, i * 0.12));
  },
  click(): void {
    tone(1200, 0.03, 0.05, "square");
  },
};
