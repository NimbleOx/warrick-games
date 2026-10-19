// Ricochet Alley's sounds, made from the kit's synthesized tones and noise bursts.
import { noiseBurst, tone } from "@warrick/kit/client/audio";

export const sfx = {
  fire(): void {
    tone(520, 0.08, 0.22, "square", 180);
    noiseBurst(0.06, 4000, 0.12, "highpass");
  },
  bounce(): void {
    tone(1400 + Math.random() * 300, 0.035, 0.05, "triangle", 900);
  },
  boom(): void {
    noiseBurst(0.7, 1200, 0.8);
    tone(110, 0.5, 0.55, "sine", 30);
  },
  empty(): void {
    tone(180, 0.06, 0.12, "square", 140);
  },
  beep(): void {
    tone(660, 0.1, 0.14, "square");
  },
  go(): void {
    tone(990, 0.22, 0.16, "square");
  },
  win(): void {
    tone(523, 0.12, 0.14, "square");
    tone(659, 0.12, 0.14, "square", 659, 0.12);
    tone(784, 0.24, 0.14, "square", 784, 0.24);
  },
};
