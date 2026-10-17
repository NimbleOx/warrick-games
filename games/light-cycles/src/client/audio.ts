// Tiny synthesized sound effects; no audio files to load.

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let master: GainNode | null = null;
let muted = readMuted();

function readMuted(): boolean {
  try {
    return localStorage.getItem("lc.muted") === "1";
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
    localStorage.setItem("lc.muted", m ? "1" : "0");
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
  turn(): void {
    tone(520, 0.05, 0.06, "square", 660);
  },
  boost(): void {
    tone(180, 0.45, 0.18, "sawtooth", 900);
    noiseBurst(0.35, 4000, 0.12, "highpass");
  },
  /** Somebody else derezzed; `near` is louder (it was you, or close by). */
  crash(near: boolean): void {
    noiseBurst(near ? 0.7 : 0.35, near ? 2400 : 1600, near ? 0.55 : 0.22);
    for (let i = 0; i < 4; i++) tone(880 / (i + 1), 0.08, near ? 0.12 : 0.05, "square", 220 / (i + 1), i * 0.06);
  },
  count(): void {
    tone(440, 0.12, 0.14, "square");
  },
  go(): void {
    tone(880, 0.3, 0.16, "square");
    tone(1320, 0.3, 0.08, "square");
  },
  win(): void {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.16, 0.12, "square", f, i * 0.11));
  },
  click(): void {
    tone(1200, 0.03, 0.05, "square");
  },
};
