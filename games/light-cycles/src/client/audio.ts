// Light Cycles' sound effects, built on the kit's synthesized-sound core (which also does mute).
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  turn(): void {
    tone(520, 0.05, 0.06, "square", 660);
  },
  boost(): void {
    tone(180, 0.45, 0.18, "sawtooth", 900);
    noiseBurst(0.35, 4000, 0.12, "highpass");
  },
  /** Somebody derezzed; `near` (it was you) is louder. */
  crash(near: boolean): void {
    noiseBurst(near ? 0.7 : 0.35, near ? 2400 : 1600, near ? 0.55 : 0.22);
    for (let i = 0; i < 4; i++) tone(880 / (i + 1), 0.08, near ? 0.12 : 0.05, "square", 220 / (i + 1), i * 0.06);
  },
  count(): void {
    tone(440, 0.12, 0.14, "square");
  },
  go(): void {
    tone(880, 0.3, 0.16, "square");
    tone(1320, 0.3, 0.08, "square");
  },
  win(): void {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.16, 0.12, "square", f, i * 0.11));
  },
};
