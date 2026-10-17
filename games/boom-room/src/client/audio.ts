// Tiny synthesized sound effects; no audio files to load.

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let master: GainNode | null = null;
let muted = readMuted();

function readMuted(): boolean {
  try {
    return localStorage.getItem("br.muted") === "1";
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
    localStorage.setItem("br.muted", m ? "1" : "0");
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
  place(): void {
    tone(220, 0.08, 0.35, "triangle", 110);
    noiseBurst(0.05, 1800, 0.15);
  },
  boom(cells: number): void {
    const size = Math.min(1, cells / 18);
    noiseBurst(0.35 + size * 0.6, 1100 + size * 500, 0.45 + size * 0.4);
    tone(110, 0.25 + size * 0.4, 0.35 + size * 0.3, "sine", 35);
  },
  pickup(): void {
    tone(660, 0.07, 0.12, "square", 660);
    tone(880, 0.07, 0.12, "square", 880, 0.06);
    tone(1320, 0.1, 0.12, "square", 1320, 0.12);
  },
  curse(): void {
    tone(300, 0.35, 0.15, "sawtooth", 140);
    tone(310, 0.35, 0.1, "sawtooth", 145, 0.05);
  },
  kick(): void {
    tone(140, 0.08, 0.35, "square", 60);
    noiseBurst(0.08, 900, 0.2);
  },
  die(): void {
    tone(700, 0.5, 0.2, "square", 90);
    noiseBurst(0.3, 1400, 0.2, "bandpass");
  },
  count(): void {
    tone(520, 0.12, 0.14, "square");
  },
  go(): void {
    tone(1040, 0.3, 0.16, "square", 1040);
  },
  hurry(): void {
    for (let i = 0; i < 4; i++) tone(i % 2 ? 660 : 880, 0.14, 0.14, "square", i % 2 ? 660 : 880, i * 0.16);
  },
  drop(): void {
    tone(90, 0.12, 0.3, "triangle", 40);
  },
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 0.13, "square", f, i * 0.12));
  },
  click(): void {
    tone(1200, 0.03, 0.05, "square");
  },
};
