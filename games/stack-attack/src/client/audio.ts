// Tiny synthesized sound effects; no audio files to load.

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let master: GainNode | null = null;
let muted = readMuted();

function readMuted(): boolean {
  try {
    return localStorage.getItem("sa.muted") === "1";
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
    localStorage.setItem("sa.muted", m ? "1" : "0");
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
  shift(): void {
    tone(900, 0.02, 0.035, "square");
  },
  turn(): void {
    tone(640, 0.04, 0.05, "square", 820);
  },
  hold(): void {
    tone(520, 0.06, 0.07, "triangle", 390);
  },
  fail(): void {
    tone(160, 0.05, 0.05, "square");
  },
  land(): void {
    noiseBurst(0.05, 900, 0.08);
  },
  lock(): void {
    noiseBurst(0.07, 1300, 0.14);
    tone(180, 0.06, 0.08, "triangle", 120);
  },
  /** A clear; bigger ones climb higher. */
  clear(lines: number, special: boolean): void {
    const base = special ? 660 : 440 + lines * 60;
    const notes = special ? [1, 1.25, 1.5, 2] : [1, 1.25, 1.5].slice(0, Math.max(1, lines));
    notes.forEach((m, i) => tone(base * m, 0.1, 0.13, "square", base * m, i * 0.06));
    noiseBurst(0.18, 5000, 0.07, "highpass");
  },
  /** Garbage is on its way to you. */
  warn(): void {
    tone(220, 0.12, 0.12, "sawtooth", 180);
    tone(220, 0.12, 0.12, "sawtooth", 180, 0.15);
  },
  /** Garbage rose into your board. */
  rise(lines: number): void {
    noiseBurst(0.12 + Math.min(lines, 8) * 0.03, 500, 0.3);
    tone(110, 0.2, 0.15, "square", 70);
  },
  /** You sent garbage. */
  send(lines: number): void {
    tone(500, 0.12 + Math.min(lines, 10) * 0.02, 0.1, "sawtooth", 1400);
  },
  /** You topped out. */
  die(): void {
    noiseBurst(0.6, 1200, 0.4);
    tone(330, 0.7, 0.22, "sawtooth", 50);
  },
  /** You knocked someone out. */
  ko(): void {
    tone(1400, 0.12, 0.16, "square", 500);
    tone(1800, 0.2, 0.14, "square", 900, 0.1);
  },
  /** Someone else went out. */
  thud(): void {
    noiseBurst(0.18, 700, 0.16);
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
};
