// Base Jump's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  /** Your units roll out. */
  send(): void {
    noiseBurst(0.16, 900, 0.12);
    tone(180, 0.12, 0.08, "square", 140);
  },
  /** You took a base from a player. */
  take(): void {
    tone(523, 0.09, 0.13, "square");
    tone(784, 0.16, 0.13, "square", 784, 0.08);
  },
  /** You took a neutral base. */
  claim(): void {
    tone(660, 0.08, 0.1, "triangle", 880);
  },
  /** A base of yours fell. */
  lose(): void {
    noiseBurst(0.35, 700, 0.35);
    tone(260, 0.3, 0.16, "sawtooth", 90);
  },
  /** Your attack bounced off. */
  bounce(): void {
    noiseBurst(0.12, 1800, 0.12, "highpass");
  },
  upgrade(): void {
    [392, 523, 659].forEach((f, i) => tone(f, 0.1, 0.11, "triangle", f, i * 0.06));
  },
  /** Someone is out. */
  out(): void {
    noiseBurst(0.5, 500, 0.3);
  },
  /** You're out. */
  dead(): void {
    noiseBurst(0.6, 1200, 0.4);
    tone(300, 0.7, 0.2, "sawtooth", 50);
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
  deny(): void {
    tone(160, 0.12, 0.1, "square", 120);
  },
};
