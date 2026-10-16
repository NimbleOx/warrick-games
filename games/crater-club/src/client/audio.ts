// Crater Club's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  fire(): void {
    tone(170, 0.18, 0.5, "triangle", 50);
    noiseBurst(0.12, 2500, 0.35);
  },
  boom(r: number): void {
    const size = Math.min(1, r / 90);
    noiseBurst(0.35 + size * 1.1, 900 + size * 600, 0.5 + size * 0.5);
    tone(90, 0.3 + size * 0.6, 0.5 * size + 0.2, "sine", 30);
  },
  dirt(): void {
    noiseBurst(0.4, 500, 0.4);
  },
  split(): void {
    tone(900, 0.12, 0.15, "square", 300);
  },
  chute(): void {
    noiseBurst(0.5, 3000, 0.12, "highpass");
  },
  turn(): void {
    tone(660, 0.09, 0.12, "square");
    tone(990, 0.12, 0.12, "square", 990, 0.1);
  },
  click(): void {
    tone(1200, 0.03, 0.05, "square");
  },
};
