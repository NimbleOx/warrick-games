// Shove Off's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  /** Picking a marble: a light tap. */
  pick(): void {
    tone(1180, 0.035, 0.06, "triangle", 1320);
  },
  /** Marbles roll a hole: a short rumble, heavier for more of them. */
  move(n: number): void {
    noiseBurst(0.09 + n * 0.02, 900 - n * 120, 0.18, "lowpass");
    tone(210 - n * 20, 0.08, 0.12, "triangle", 160);
  },
  /** Marbles knock into theirs: a glassy clack. */
  push(): void {
    tone(1760, 0.05, 0.16, "sine", 1500);
    tone(2350, 0.04, 0.1, "sine", 2100, 0.012);
    noiseBurst(0.08, 900, 0.16, "lowpass");
  },
  /** One goes over the edge: the clack, then a drop into the gutter. */
  off(): void {
    tone(1760, 0.05, 0.16, "sine", 1500);
    noiseBurst(0.08, 900, 0.16, "lowpass");
    tone(620, 0.32, 0.14, "triangle", 120, 0.12);
    tone(160, 0.12, 0.2, "sine", 90, 0.42);
  },
  nope(): void {
    tone(150, 0.14, 0.18, "sawtooth", 110);
  },
  /** It's your turn. */
  yourTurn(): void {
    tone(988, 0.16, 0.08, "sine");
    tone(1318, 0.26, 0.08, "sine", 1318, 0.09);
  },
  start(): void {
    [523, 659, 784].forEach((f, i) => tone(f, 0.14, 0.08, "triangle", f, i * 0.09));
  },
  gameOver(win: boolean): void {
    const notes = win ? [523, 659, 784, 1046] : [523, 494, 440, 392];
    notes.forEach((f, i) => tone(f, 0.22, 0.12, "square", f, i * 0.13));
  },
};
