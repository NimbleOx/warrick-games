// Turf War's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  /** Closing a loop; bigger claims sound bigger. */
  claim(cells: number): void {
    const lift = Math.min(1, cells / 120);
    const base = 440 + lift * 220;
    tone(base, 0.09, 0.14, "square");
    tone(base * 1.25, 0.09, 0.14, "square", base * 1.25, 0.07);
    tone(base * 1.5, 0.14 + lift * 0.2, 0.14, "square", base * 1.5, 0.14);
  },
  /** You went down. */
  die(): void {
    noiseBurst(0.45, 1400, 0.45);
    tone(320, 0.5, 0.25, "sawtooth", 60);
  },
  /** You cut someone. */
  kill(): void {
    tone(1400, 0.12, 0.16, "square", 500);
    noiseBurst(0.15, 4000, 0.2, "highpass");
  },
  /** Someone else went down. */
  thud(): void {
    noiseBurst(0.18, 700, 0.18);
  },
  spawn(): void {
    tone(330, 0.08, 0.12, "triangle", 660);
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
