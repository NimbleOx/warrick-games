// Flip Side's sounds, built on the kit's synthesized-sound core (which also does mute).
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  count(): void {
    tone(440, 0.12, 0.12, "square");
  },
  go(): void {
    tone(880, 0.3, 0.13, "square");
    tone(1320, 0.3, 0.06, "square");
  },
  flipper(): void {
    noiseBurst(0.05, 2400, 0.12, "bandpass");
    tone(150, 0.05, 0.08, "square", 90);
  },
  bumper(i: number): void {
    tone(520 + i * 90, 0.09, 0.1, "square", 260 + i * 40);
    noiseBurst(0.06, 3000, 0.08, "highpass");
  },
  sling(): void {
    tone(330, 0.06, 0.09, "sawtooth", 180);
    noiseBurst(0.05, 1800, 0.07);
  },
  hit(): void {
    noiseBurst(0.04, 1200, 0.06);
  },
  drop(): void {
    tone(200, 0.1, 0.11, "square", 110);
    noiseBurst(0.08, 900, 0.1);
  },
  bank(): void {
    [523, 659, 784].forEach((f, i) => tone(f, 0.12, 0.1, "square", f, i * 0.07));
  },
  target(): void {
    tone(1200, 0.06, 0.08, "triangle", 900);
  },
  lane(): void {
    tone(988, 0.08, 0.08, "triangle");
    tone(1319, 0.12, 0.06, "triangle", 1319, 0.06);
  },
  lanes(): void {
    [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.1, 0.09, "square", f, i * 0.06));
  },
  orbit(combo: number): void {
    tone(300 + combo * 80, 0.35, 0.09, "sawtooth", 900 + combo * 150);
  },
  scoop(): void {
    tone(180, 0.18, 0.12, "square", 70);
  },
  eject(): void {
    noiseBurst(0.08, 1500, 0.1);
    tone(240, 0.06, 0.08, "square", 400);
  },
  lock(): void {
    tone(392, 0.15, 0.12, "square");
    tone(587, 0.25, 0.12, "square", 587, 0.12);
  },
  multiball(): void {
    [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => tone(f, 0.14, 0.12, "square", f, i * 0.08));
  },
  jackpot(): void {
    [659, 784, 988, 1318, 1568].forEach((f, i) => tone(f, 0.18, 0.13, "square", f, i * 0.09));
    noiseBurst(0.5, 4000, 0.06, "highpass");
  },
  skill(): void {
    [1046, 1318, 1568, 2093].forEach((f, i) => tone(f, 0.12, 0.1, "triangle", f, i * 0.07));
  },
  launch(): void {
    noiseBurst(0.12, 900, 0.14);
    tone(110, 0.12, 0.1, "sawtooth", 220);
  },
  saved(): void {
    tone(660, 0.12, 0.1, "triangle");
    tone(990, 0.2, 0.1, "triangle", 990, 0.1);
  },
  drain(): void {
    tone(392, 0.6, 0.12, "sawtooth", 98);
  },
  lost(): void {
    tone(300, 0.25, 0.08, "triangle", 150);
  },
  bonus(): void {
    tone(880, 0.06, 0.06, "square");
  },
  nudge(): void {
    noiseBurst(0.12, 300, 0.2);
  },
  warn(): void {
    tone(200, 0.18, 0.12, "square");
    tone(200, 0.18, 0.12, "square", 200, 0.24);
  },
  tilt(): void {
    tone(120, 0.9, 0.15, "sawtooth", 60);
  },
  /** Your power was full: trouble's on its way to a rival. */
  send(): void {
    tone(220, 0.3, 0.1, "sawtooth", 1760);
  },
  /** Trouble is coming at you. */
  incoming(): void {
    tone(1400, 0.1, 0.09, "square", 1400);
    tone(1000, 0.1, 0.09, "square", 1000, 0.13);
    tone(1400, 0.1, 0.09, "square", 1400, 0.26);
  },
  /** It's landed. */
  trouble(): void {
    noiseBurst(0.35, 600, 0.18);
    tone(160, 0.3, 0.12, "sawtooth", 60);
  },
  over(): void {
    [523, 392, 330, 262].forEach((f, i) => tone(f, 0.22, 0.1, "triangle", f, i * 0.16));
  },
  win(): void {
    [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, 0.16, 0.12, "square", f, i * 0.11));
  },
};
