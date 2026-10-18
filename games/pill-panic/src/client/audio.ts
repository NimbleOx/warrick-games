// Tiny synthesized sound effects; no audio files to load.

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let master: GainNode | null = null;
let muted = readMuted();

function readMuted(): boolean {
  try {
    return localStorage.getItem("pp.muted") === "1";
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
    localStorage.setItem("pp.muted", m ? "1" : "0");
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

function noiseBurst(dur: number, freq: number, gain: number, type: BiquadFilterType = "lowpass", delay = 0): void {
  const c = ready();
  if (!c || !noise) return;
  const t0 = c.currentTime + delay;
  const src = c.createBufferSource();
  src.buffer = noise;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.15), t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(f).connect(g).connect(master!);
  src.start(t0);
  src.stop(t0 + dur);
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
  move(): void {
    tone(220, 0.03, 0.05, "square");
  },
  rotate(): void {
    tone(660, 0.04, 0.06, "square", 880);
  },
  land(): void {
    tone(140, 0.08, 0.14, "triangle", 70);
  },
  /** Lines popping; each step of a chain climbs higher. */
  pop(chain: number, viruses: number): void {
    const base = 520 * 2 ** ((Math.min(chain, 6) - 1) / 4);
    tone(base, 0.08, 0.13, "square");
    tone(base * 1.26, 0.08, 0.13, "square", base * 1.26, 0.06);
    tone(base * 1.5, 0.14, 0.13, "square", base * 1.5, 0.12);
    if (viruses) noiseBurst(0.18, 2600, 0.18, "bandpass", 0.05);
  },
  /** We sent an attack. */
  attack(): void {
    noiseBurst(0.3, 5000, 0.22, "highpass");
    tone(900, 0.25, 0.12, "sawtooth", 1800);
  },
  /** An attack is on its way to us. */
  warn(): void {
    tone(330, 0.1, 0.14, "square");
    tone(250, 0.16, 0.14, "square", 250, 0.11);
  },
  /** Garbage rattling into our bottle. */
  garbage(): void {
    for (let i = 0; i < 4; i++) tone(180 + i * 25, 0.05, 0.1, "square", 120, i * 0.06);
  },
  count(): void {
    tone(520, 0.12, 0.14, "square");
  },
  go(): void {
    tone(1040, 0.3, 0.16, "square");
  },
  /** Our bottle is clear. */
  clear(): void {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.16, 0.14, "square", f, i * 0.09));
  },
  /** Our bottle filled up. */
  out(): void {
    noiseBurst(0.5, 1200, 0.4);
    tone(330, 0.6, 0.22, "sawtooth", 55);
  },
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 0.14, "square", f, i * 0.12));
    tone(1047, 0.5, 0.14, "triangle", 1047, 0.5);
  },
  lose(): void {
    [392, 330, 262].forEach((f, i) => tone(f, 0.22, 0.12, "triangle", f, i * 0.18));
  },
};
