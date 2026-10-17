// Tiny synthesized sound effects; no audio files to load.

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let master: GainNode | null = null;
let muted = readMuted();

function readMuted(): boolean {
  try {
    return localStorage.getItem("cb.muted") === "1";
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
    localStorage.setItem("cb.muted", m ? "1" : "0");
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
  /** Someone crashed; louder when it's you. */
  crash(mine: boolean): void {
    noiseBurst(mine ? 0.5 : 0.25, mine ? 1400 : 2200, mine ? 0.55 : 0.25);
    tone(mine ? 220 : 440, mine ? 0.35 : 0.15, mine ? 0.3 : 0.12, "sawtooth", mine ? 55 : 160);
  },
  beep(): void {
    tone(520, 0.12, 0.14, "square");
  },
  go(): void {
    tone(880, 0.25, 0.16, "square");
  },
  win(): void {
    tone(523, 0.12, 0.12, "square");
    tone(659, 0.12, 0.12, "square", 659, 0.12);
    tone(784, 0.25, 0.12, "square", 784, 0.24);
  },
  click(): void {
    tone(1200, 0.03, 0.05, "square");
  },
};
