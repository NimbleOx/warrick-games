// Curve Ball's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  /** Someone crashed; louder when it's you. */
  crash(mine: boolean): void {
    noiseBurst(mine ? 0.5 : 0.25, mine ? 1400 : 2200, mine ? 0.55 : 0.25);
    tone(mine ? 220 : 440, mine ? 0.35 : 0.15, mine ? 0.3 : 0.12, "sawtooth", mine ? 55 : 160);
  },
  beep(): void {
    tone(520, 0.12, 0.14, "square");
  },
  go(): void {
    tone(880, 0.25, 0.16, "square");
  },
  win(): void {
    tone(523, 0.12, 0.12, "square");
    tone(659, 0.12, 0.12, "square", 659, 0.12);
    tone(784, 0.25, 0.12, "square", 784, 0.24);
  },
  click(): void {
    tone(1200, 0.03, 0.05, "square");
  },
};
