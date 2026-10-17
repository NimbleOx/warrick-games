// Tiny synthesized sound effects; no audio files to load.

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let master: GainNode | null = null;
let muted = readMuted();

function readMuted(): boolean {
  try {
    return localStorage.getItem("tw.muted") === "1";
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem("tw.muted", m ? "1" : "0");
  } catch {
    // Storage may be unavailable; the setting just won't stick.
  }
  if (master) master.gain.value = m ? 0 : 0.5;
}

/** Browsers only allow audio after a user gesture; call this from one. */
export function unlockAudio(): void {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") void ctx.resume();
}

function ready(): AudioContext | null {
  return ctx && master && !muted && ctx.state === "running" ? ctx : null;
}

function noiseBurst(dur: number, freq: number, gain: number, type: BiquadFilterType = "lowpass"): void {
  const c = ready();
  if (!c || !noise) return;
  const src = c.createBufferSource();
  src.buffer = noise;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, c.currentTime);
  f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.15), c.currentTime + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
  src.connect(f).connect(g).connect(master!);
  src.start();
  src.stop(c.currentTime + dur);
}

function tone(freq: number, dur: number, gain: number, type: OscillatorType, endFreq = freq, delay = 0): void {
  const c = ready();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g).connect(master!);
  o.start(t0);
  o.stop(t0 + dur);
}

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
  click(): void {
    tone(1200, 0.03, 0.05, "square");
  },
};
