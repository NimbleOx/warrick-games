// Corner Shop's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  /** A piece lands: a wooden clack, higher for small pieces. */
  place(size: number): void {
    tone(320 - size * 30, 0.08, 0.35, "triangle", 120);
    noiseBurst(0.06, 2200, 0.25, "bandpass");
  },
  /** Someone else's piece lands. */
  other(): void {
    tone(240, 0.06, 0.16, "triangle", 110);
    noiseBurst(0.04, 1800, 0.1, "bandpass");
  },
  pick(): void {
    tone(880, 0.04, 0.07, "square", 1100);
  },
  turn(): void {
    noiseBurst(0.03, 3000, 0.05, "highpass");
    tone(1046, 0.05, 0.05, "sine");
  },
  nope(): void {
    tone(150, 0.14, 0.18, "sawtooth", 110);
  },
  /** It's your turn: the shop bell. */
  yourTurn(): void {
    tone(1318, 0.25, 0.12, "sine");
    tone(1760, 0.35, 0.1, "sine", 1760, 0.09);
  },
  out(): void {
    tone(520, 0.18, 0.14, "triangle", 260);
    tone(390, 0.3, 0.12, "triangle", 180, 0.15);
  },
  gameOver(win: boolean): void {
    const notes = win ? [523, 659, 784, 1046] : [523, 494, 440, 392];
    notes.forEach((f, i) => tone(f, 0.22, 0.13, "square", f, i * 0.13));
  },
};
