// Tiny synthesized sounds: no audio files to load. A game builds its own `sfx` from
// `tone` and `noiseBurst`; the shell wires the mute button and unlocks audio on the first gesture.
import { store } from "./dom";

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let master: GainNode | null = null;
/** Read lazily: the store's prefix is set when the game's shell starts. */
let muted: boolean | null = null;

export function isMuted(): boolean {
  muted ??= store("muted") === "1";
  return muted;
}

export function setMuted(m: boolean): void {
  muted = m;
  store("muted", m ? "1" : "0");
  if (master) master.gain.value = m ? 0 : 0.5;
}

/** Browsers only allow audio after a user gesture; call this from one. */
export function unlockAudio(): void {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = isMuted() ? 0 : 0.5;
    master.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") void ctx.resume();
}

function ready(): AudioContext | null {
  return ctx && master && !isMuted() && ctx.state === "running" ? ctx : null;
}

export function noiseBurst(dur: number, freq: number, gain: number, type: BiquadFilterType = "lowpass"): void {
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

export function tone(freq: number, dur: number, gain: number, type: OscillatorType, endFreq = freq, delay = 0): void {
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
