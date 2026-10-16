// Box Office's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  line(): void {
    tone(440, 0.05, 0.1, "triangle", 380);
  },
  /** A box claimed; `run` counts the boxes in a row, so a long chain climbs. */
  box(run: number): void {
    const step = Math.min(run, 12);
    tone(520 * Math.pow(1.06, step), 0.09, 0.14, "square", 700 * Math.pow(1.06, step));
    noiseBurst(0.05, 4000, 0.05, "highpass");
  },
  turn(): void {
    tone(660, 0.09, 0.12, "square");
    tone(990, 0.12, 0.12, "square", 990, 0.1);
  },
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 0.14, "square", f, i * 0.11));
  },
  nope(): void {
    tone(180, 0.12, 0.12, "sawtooth", 120);
  },
};
