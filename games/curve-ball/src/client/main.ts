import { CODE_RE, MAX_PLAYERS, PLAYER_COLORS, SUBSTEPS, TICK_MS, WIN_LEAD } from "../shared/constants";
import {
  SETTING_CHOICES,
  autoTarget,
  rankPlayers,
  type FrameMsg,
  type GameState,
  type LogEntry,
  type PlayerState,
  type RoundSnapshot,
  type ServerMsg,
  type Settings,
} from "../shared/protocol";
import { Round, coast, type Steer } from "../shared/sim";
import { Attract } from "./attract";
import { isMuted, setMuted, sfx, unlockAudio } from "./audio";
import { Steering } from "./input";
import { Connection, type NetStatus } from "./net";
import { Renderer, type HeadStyle, type Prediction } from "./render";

// ------------------------------------------------------------------ helpers

// The app lives under Vite's `base` ("/curve-ball/"): BASE is the home screen, gamePath() a game.
const BASE = import.meta.env.BASE_URL;
const gamePath = (code: string) => `${BASE}g/${code}`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function store(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode etc. — identity just won't survive a reload.
  }
  return value ?? null;
}

function playerToken(): string {
  let t = store("cb.token");
  if (!t || !/^[\w-]{8,64}$/.test(t)) {
    t = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    store("cb.token", t);
  }
  return t;
}

let toastTimer = 0;
function toast(text: string, kind: "error" | "info" = "error"): void {
  const el = $("toast");
  el.textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 3200);
}

const touchScreen = window.matchMedia("(pointer: coarse)").matches;
/** Draw your own head ahead of the server. `?predict=0` turns it off, to compare. */
const predicting = new URLSearchParams(location.search).get("predict") !== "0";

// ------------------------------------------------------------------ app state

type Screen = "home" | "lobby" | "game";

/** The round on screen, kept in step by the server's frames. */
interface Play {
  num: number;
  round: Round;
  /** Frames received but not shown yet. */
  queue: FrameMsg[];
  /** Ticks we have frames for. */
  received: number;
  /** Where playback is, in ticks. Runs a little behind `received` to smooth out network jitter. */
  clock: number;
  /** Waiting for a fresh snapshot after a missed frame or a checksum mismatch. */
  stale: boolean;
}

/** How far behind the newest frame playback aims to be, in ticks. */
const BUFFER_TICKS = 1.5;
/** Further behind than this (say, the tab was in the background) and playback skips ahead. */
const MAX_BEHIND_TICKS = 45;

const app = {
  screen: "home" as Screen,
  conn: null as Connection | null,
  code: "",
  me: "",
  state: null as GameState | null,
  log: [] as LogEntry[],
  skew: 0,
  play: null as Play | null,
  bannerUntil: 0,
  lastFrame: 0,
  lastCount: -1,
};

const token = playerToken();
const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));
const steering = new Steering(canSteer, sendSteer);

const serverNow = () => Date.now() + app.skew;
const me = (s = app.state): PlayerState | undefined => s?.players.find((p) => p.id === app.me);
const playerById = (id: string | null | undefined) => app.state?.players.find((p) => p.id === id);
const canHost = (s = app.state) => {
  if (!s) return false;
  if (s.hostId === app.me) return true;
  const host = s.players.find((p) => p.id === s.hostId);
  return !host || !host.connected;
};
const isLive = (s = app.state) => !!s && (s.phase === "countdown" || s.phase === "playing");

/** My head in the round on screen, if I have one. */
function myHead() {
  const r = app.play?.round;
  const i = r ? r.index(app.me) : -1;
  return i >= 0 ? r!.heads[i] : null;
}

/** Points earned so far in the round on screen, by player id. Already counted in scores once it's over. */
function livePoints(): Map<string, number> {
  const out = new Map<string, number>();
  const s = app.state;
  const p = app.play;
  if (!s || !p || !isLive(s) || p.num !== s.round) return out;
  for (const h of p.round.heads) out.set(h.id, h.points);
  return out;
}

// ------------------------------------------------------------------ routing

function route(): void {
  const m = location.pathname.slice(BASE.length).match(/^g\/([A-Za-z0-9]{5})\/?$/);
  const code = m?.[1].toUpperCase();
  if (code && CODE_RE.test(code)) {
    // Coming back to a game you were in (reload, reconnect): straight back in.
    if (store("cb.lastGame") === code && store("cb.name")) void joinGame(code);
    else showHome(code);
  } else {
    showHome(null);
  }
}

function showScreen(screen: Screen): void {
  app.screen = screen;
  $("screen-home").hidden = screen !== "home";
  $("screen-lobby").hidden = screen !== "lobby";
  $("screen-game").hidden = screen !== "game";
  window.scrollTo(0, 0);
  if (screen === "game") layoutStage();
  if (screen === "home") attract.resize();
}

function showHome(inviteCode: string | null): void {
  disconnect();
  showScreen("home");
  document.title = "Curve Ball";
  $("home-error").textContent = "";
  const nameInput = $<HTMLInputElement>("home-name");
  nameInput.value = store("cb.name") ?? "";
  $("home-join-invite").hidden = !inviteCode;
  $("home-default").hidden = !!inviteCode;
  if (inviteCode) {
    $("home-invite-code").textContent = inviteCode;
    $("home-join-invite-btn").dataset.code = inviteCode;
  }
  if (!nameInput.value) nameInput.focus();
}

function readName(): string | null {
  const input = $<HTMLInputElement>("home-name");
  const name = input.value.trim().slice(0, 16);
  if (!name) {
    $("home-error").textContent = "Pick a name first.";
    input.focus();
    return null;
  }
  store("cb.name", name);
  return name;
}

async function createGame(): Promise<void> {
  if (!readName()) return;
  const btn = $<HTMLButtonElement>("home-create");
  btn.disabled = true;
  try {
    const res = await fetch(`${BASE}api/games`, { method: "POST" });
    const body = (await res.json()) as { code?: string; error?: string };
    if (!res.ok || !body.code) throw new Error(body.error ?? "Couldn't create a game");
    history.pushState(null, "", gamePath(body.code));
    await joinGame(body.code);
  } catch (err) {
    $("home-error").textContent = err instanceof Error ? err.message : String(err);
  } finally {
    btn.disabled = false;
  }
}

async function joinGame(code: string): Promise<void> {
  code = code.toUpperCase();
  if (!CODE_RE.test(code)) {
    $("home-error").textContent = "Codes are 5 letters/numbers.";
    return;
  }
  const name = store("cb.name") ?? readName();
  if (!name) return;
  try {
    const res = await fetch(`${BASE}api/games/${code}`);
    if (res.status === 404) {
      store("cb.lastGame", null);
      if (location.pathname !== BASE) history.replaceState(null, "", BASE);
      showHome(null);
      $("home-error").textContent = `No game with code ${code}. It may have expired.`;
      return;
    }
    if (!res.ok) throw new Error("The server didn't answer. Try again?");
  } catch (err) {
    showHome(code);
    $("home-error").textContent = err instanceof Error ? err.message : String(err);
    return;
  }

  disconnect();
  store("cb.lastGame", code);
  if (location.pathname !== gamePath(code)) history.pushState(null, "", gamePath(code));
  app.code = code;
  app.state = null;
  app.log = [];
  app.me = "";
  $("lobby-code").textContent = code;
  $<HTMLInputElement>("lobby-link").value = location.origin + gamePath(code);
  $("game-code-small").textContent = code;
  $("lobby-players").innerHTML = `<li class="muted">Connecting…</li>`;
  showScreen("lobby");

  app.conn = new Connection(code, {
    hello: () => ({ t: "hello", token, name: store("cb.name") ?? name }),
    message: onMessage,
    status: onStatus,
    fatal: (reason) => {
      store("cb.lastGame", null);
      history.pushState(null, "", BASE);
      showHome(null);
      $("home-error").textContent = reason;
    },
  });
}

function disconnect(): void {
  app.conn?.close();
  app.conn = null;
  app.state = null;
  app.play = null;
  steering.releaseAll();
  $("gameover").hidden = true;
}

function leave(): void {
  const s = app.state;
  if (s && s.phase !== "lobby" && s.phase !== "gameover" && !confirm("Leave this game? You'll miss the rest of the match.")) return;
  app.conn?.send({ t: "leave" });
  store("cb.lastGame", null);
  history.pushState(null, "", BASE);
  showHome(null);
}

function onStatus(status: NetStatus): void {
  for (const el of [$("lobby-conn"), $("game-conn")]) {
    el.dataset.status = status;
    el.textContent = status === "open" ? "" : status === "connecting" ? "Connecting…" : "Reconnecting…";
  }
}

// ------------------------------------------------------------------ messages

function onMessage(msg: ServerMsg): void {
  if ("now" in msg) app.skew = msg.now - Date.now();
  switch (msg.t) {
    case "welcome":
      app.me = msg.you;
      app.log = msg.log;
      app.state = msg.state;
      setRound(msg.round);
      applyState(msg.state);
      renderLog();
      // Still holding a key from before a reconnect? Tell the server.
      if (steering.value !== 0) sendSteer(steering.value);
      break;
    case "state":
      applyState(msg.state);
      break;
    case "round":
      setRound(msg.round);
      render();
      break;
    case "f":
      onFrame(msg);
      break;
    case "log":
      app.log.push(...msg.entries);
      if (app.log.length > 120) app.log.splice(0, app.log.length - 120);
      renderLog();
      break;
    case "error":
      toast(msg.message);
      break;
  }
}

function applyState(s: GameState): void {
  const prev = app.state;
  app.state = s;
  if (s.phase === "lobby") app.play = null;
  if (prev && prev.phase !== s.phase) {
    if (s.phase === "playing") {
      sfx.go();
      flashBanner(`<span class="count">GO!</span>`, 700);
      // Hand the arrow keys to the game.
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.closest("input, select, button")) focused.blur();
    } else if (s.phase === "roundover") {
      steering.releaseAll();
      if (s.roundWinnerId === app.me) sfx.win();
    } else if (s.phase === "countdown") {
      app.lastCount = -1;
    }
  }
  app.conn?.heartbeat(isLive(s));
  document.title = isLive(s) && myHead()?.alive ? `▶ Curve Ball · ${s.code}` : `Curve Ball · ${s.code}`;
  render();
}

/** Rebuild a round from its snapshot: replay every tick, drawing trails as it goes. */
function setRound(snap: RoundSnapshot | null): void {
  if (!snap) {
    app.play = null;
    return;
  }
  const round = new Round(snap);
  renderer.reset(round);
  const styles = headStyles(round);
  let k = 0;
  for (;;) {
    while (k < snap.inputs.length && snap.inputs[k][0] <= round.tick) {
      round.setSteer(snap.inputs[k][1], snap.inputs[k][2]);
      k++;
    }
    if (round.tick >= snap.tick || round.over) break;
    round.step();
    renderer.afterStep(round, styles);
  }
  app.play = { num: snap.num, round, queue: [], received: round.tick, clock: round.tick, stale: false };
}

function onFrame(f: FrameMsg): void {
  const p = app.play;
  if (!p || p.stale || f.n < p.received) return;
  if (f.n > p.received) return resync(p);
  p.queue.push(f);
  p.received = f.n + 1;
}

/** Something went missing or drifted: ask for a fresh snapshot and ignore frames until it comes. */
function resync(p: Play): void {
  if (p.stale) return;
  p.stale = true;
  console.warn(`Curve Ball: resyncing round ${p.num} at tick ${p.round.tick}`);
  app.conn?.send({ t: "resync" });
}

function applyFrame(p: Play, f: FrameMsg): void {
  const { round } = p;
  const mine = round.index(app.me);
  for (const [slot, s] of f.i ?? []) {
    round.setSteer(slot, s);
    if (slot === mine) onEcho(s);
  }
  const deaths = round.step();
  const styles = headStyles(round);
  renderer.afterStep(round, styles);
  for (const d of deaths) {
    const h = round.heads[d.slot];
    renderer.crash(h.x, h.y, styles[d.slot]?.color ?? "#fff");
    sfx.crash(h.id === app.me);
  }
  const expected = (f.d ?? []).join();
  if (deaths.map((d) => d.slot).join() !== expected || (f.c !== undefined && f.c !== round.checksum())) {
    resync(p);
  }
  if (deaths.length && app.state) renderGame(app.state);
}

function headStyles(round: Round): HeadStyle[] {
  return round.heads.map((h) => {
    const p = playerById(h.id);
    return { name: p?.name ?? "?", color: p?.color ?? "#ffffff", you: h.id === app.me };
  });
}

// ------------------------------------------------------------------ steering & prediction

/** Local steering over the last couple of seconds, oldest first: [performance.now(), steer]. */
const steerHistory: [number, Steer][] = [[0, 0]];
/** Steering changes sent during play that the server hasn't echoed back yet: [sent at, steer]. */
const inFlight: [number, Steer][] = [];
/** Measured ticks from pressing a key to seeing the server's frame for it play back. */
let lagTicks = 3;

function canSteer(): boolean {
  if (app.screen !== "game" || !isLive()) return false;
  return !!myHead()?.alive;
}

function sendSteer(s: Steer): void {
  const now = performance.now();
  steerHistory.push([now, s]);
  while (steerHistory.length > 2 && steerHistory[1][0] < now - 2000) steerHistory.shift();
  if (!canSteer() && s !== 0) return;
  if (app.conn?.send({ t: "steer", s }) && app.state?.phase === "playing") {
    inFlight.push([now, s]);
    if (inFlight.length > 20) inFlight.shift();
  }
}

/** One of my steering changes came back in a frame: update the lag estimate. */
function onEcho(s: Steer): void {
  const i = inFlight.findIndex(([, v]) => v === s);
  if (i < 0) return;
  const sample = (performance.now() - inFlight[i][0]) / TICK_MS;
  inFlight.splice(0, i + 1);
  if (sample > 15) return; // a stall, not the usual lag
  lagTicks = Math.min(12, Math.max(1, lagTicks * 0.7 + sample * 0.3));
}

function steerAt(t: number): Steer {
  for (let i = steerHistory.length - 1; i >= 0; i--) if (steerHistory[i][0] <= t) return steerHistory[i][1];
  return steerHistory[0][1];
}

/**
 * Where my head will be once the server has my latest steering: run a copy of
 * it forward by the measured lag, replaying my key presses with the same delay
 * the server will see them. Collisions are left to the server; the path just
 * stops short of anything solid.
 */
function predict(p: Play, alpha: number): Prediction | null {
  if (app.state?.phase !== "playing") return null;
  const { round } = p;
  const slot = round.index(app.me);
  const head = round.heads[slot];
  if (!head?.alive) return null;
  const a = Math.min(1, Math.max(0, alpha));
  const path = [round.prevX[slot] + (head.x - round.prevX[slot]) * a, round.prevY[slot] + (head.y - round.prevY[slot]) * a, 1];
  path.push(head.x, head.y, round.painted[slot] ? 1 : 0);
  const n = Math.round(lagTicks);
  const now = performance.now();
  const copy = { ...head };
  let prevX = head.x;
  let prevY = head.y;
  for (let k = 1; k <= n; k++) {
    copy.steer = steerAt(now - (n - k) * TICK_MS);
    const painted = coast(copy, round.cfg);
    if (round.blockedAt(slot, copy.x, copy.y, copy.radius, round.now + k * SUBSTEPS) !== null) break;
    // The last step is only partly done, in time with the other heads.
    const x = k < n ? copy.x : prevX + (copy.x - prevX) * a;
    const y = k < n ? copy.y : prevY + (copy.y - prevY) * a;
    path.push(x, y, painted ? 1 : 0);
    prevX = copy.x;
    prevY = copy.y;
  }
  return { slot, path, gap: copy.gap > 0 };
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(250, now - (app.lastFrame || now));
  app.lastFrame = now;
  if (app.screen === "home") {
    attract.frame(now);
    return;
  }
  if (app.screen !== "game") return;

  const p = app.play;
  if (p) advance(p, dt);
  const alpha = p ? p.clock - (p.round.tick - 1) : 1;
  renderer.draw(p?.round ?? null, {
    styles: p ? headStyles(p.round) : [],
    alpha,
    labels: app.state?.phase === "countdown",
    predicted: p && predicting ? predict(p, alpha) : null,
  });
  tickClocks();
}

/**
 * Move playback forward in real time, applying frames as it reaches them. It
 * runs faster when it falls behind, which also covers the server fast-forwarding
 * a round that only CPUs are left in.
 */
function advance(p: Play, dt: number): void {
  const latest = p.received;
  const behind = latest - p.clock;
  if (behind > MAX_BEHIND_TICKS) p.clock = latest - BUFFER_TICKS;
  else p.clock += (dt / TICK_MS) * (1 + Math.max(0, behind - BUFFER_TICKS) * 0.5);
  if (p.clock > latest) p.clock = latest;
  while (p.queue.length && p.queue[0].n < Math.ceil(p.clock) && !p.stale) applyFrame(p, p.queue.shift()!);
}

function tickClocks(): void {
  const s = app.state;
  if (!s) return;
  const secs = s.phaseDeadline ? Math.max(0, Math.ceil((s.phaseDeadline - serverNow()) / 1000)) : 0;
  if (s.phase === "countdown" && secs !== app.lastCount) {
    app.lastCount = secs;
    if (secs > 0) sfx.beep();
  }
  for (const el of $$("[data-countdown]")) {
    const text = String(secs);
    if (el.textContent !== text) el.textContent = text;
  }
  if (app.bannerUntil && performance.now() > app.bannerUntil) {
    app.bannerUntil = 0;
    renderBanner(s);
  }
}

// ------------------------------------------------------------------ rendering: top level

function render(): void {
  const s = app.state;
  if (!s || app.screen === "home") return;
  if (s.phase === "lobby") {
    if (app.screen !== "lobby") showScreen("lobby");
    renderLobby(s);
  } else if (app.screen !== "game") {
    showScreen("game");
    renderGame(s);
    // Again, now that the HUD has its contents and its real height.
    layoutStage();
  } else {
    renderGame(s);
  }
}

// ------------------------------------------------------------------ lobby

const SPEED_LABELS: Record<string, string> = { chill: "Chill", classic: "Classic", fast: "Fast" };

function settingLabel(key: keyof Settings, v: unknown, s: GameState): string {
  if (key === "target") {
    const n = s.players.filter((p) => !p.spectator).length;
    return v === 0 ? `Auto: ${autoTarget(n)} points` : `${v} points`;
  }
  return SPEED_LABELS[String(v)] ?? String(v);
}

const SETTING_NAMES: Record<keyof Settings, string> = { target: "First to", speed: "Speed" };

function renderLobby(s: GameState): void {
  const host = canHost(s);
  const participants = s.players.filter((p) => !p.spectator);
  $("lobby-count").textContent = `${participants.length}/${MAX_PLAYERS}`;

  $("lobby-players").innerHTML = s.players
    .map((p) => {
      const tags = [
        p.id === app.me ? `<span class="tag tag-you">you</span>` : "",
        p.id === s.hostId ? `<span class="tag tag-host">host</span>` : "",
        p.cpu ? `<span class="tag">CPU · ${p.cpu}</span>` : "",
        p.spectator ? `<span class="tag">watching</span>` : "",
        !p.cpu && !p.connected ? `<span class="tag">offline</span>` : "",
      ].join("");
      const kick = host && p.id !== app.me ? `<button class="kick" data-kick="${p.id}" title="Remove ${esc(p.name)}" aria-label="Remove ${esc(p.name)}">×</button>` : "";
      return `<li class="${!p.cpu && !p.connected ? "offline" : ""}">
        <span class="chip" style="background:${p.color}"></span>
        <span class="pname">${esc(p.name)}</span>${tags}<span class="spacer"></span>${kick}</li>`;
    })
    .join("");

  const full = participants.length >= MAX_PLAYERS;
  $("lobby-cpu").hidden = !host;
  for (const b of $$<HTMLButtonElement>("#lobby-cpu button")) {
    b.disabled = full;
    b.title = full ? `The game is full (${MAX_PLAYERS} players)` : "";
  }
  const fullNote = $("lobby-full");
  fullNote.hidden = !full;
  fullNote.textContent = host
    ? `The game is full (${MAX_PLAYERS}/${MAX_PLAYERS}). Remove someone to make room.`
    : `The game is full (${MAX_PLAYERS}/${MAX_PLAYERS}). Anyone else who joins will watch.`;

  const mine = me(s);
  const taken = new Set(s.players.filter((p) => p.id !== app.me).map((p) => p.color));
  $("lobby-colors").innerHTML = PLAYER_COLORS.map(
    (c) => `<button class="swatch" style="background:${c}" data-color="${c}" aria-label="Color ${c}"
      aria-pressed="${mine?.color === c}" ${taken.has(c) ? "disabled" : ""}></button>`,
  ).join("");

  $("lobby-settings").innerHTML = (Object.keys(SETTING_NAMES) as (keyof Settings)[])
    .map((key) => {
      const value = s.settings[key];
      const control = host
        ? `<select data-setting="${key}">${(SETTING_CHOICES[key] as (string | number)[])
            .map((v) => `<option value="${v}" ${v === value ? "selected" : ""}>${esc(settingLabel(key, v, s))}</option>`)
            .join("")}</select>`
        : `<span class="value">${esc(settingLabel(key, value, s))}</span>`;
      return `<label class="setting"><span class="label">${SETTING_NAMES[key]}</span>${control}</label>`;
    })
    .join("");
  const offline = s.players.some((p) => !p.cpu && !p.connected);
  $("lobby-settings-note").innerHTML = [
    `To win you also need a ${WIN_LEAD}-point lead.`,
    host ? "" : "Only the host can change settings.",
    offline ? "Offline players are removed when the game starts." : "",
  ]
    .filter(Boolean)
    .join(" ");

  const start = $<HTMLButtonElement>("lobby-start");
  start.hidden = !host;
  start.disabled = participants.length < 2;
  const hostName = playerById(s.hostId)?.name ?? "the host";
  $("lobby-wait").textContent = host
    ? participants.length < 2
      ? "You need at least two players to start. Invite a friend or add a CPU."
      : ""
    : `Waiting for ${hostName} to start the game…`;
}

// ------------------------------------------------------------------ game

function renderGame(s: GameState): void {
  renderHud(s);
  renderPlayers(s);
  renderWaiting(s);
  renderBanner(s);
  renderGameOver(s);
  $("touch-hint").hidden = !(touchScreen && s.phase === "countdown" && !!myHead());
}

function renderHud(s: GameState): void {
  const round = app.play?.round;
  const head = myHead();
  const p = me(s);
  let status = "";
  if (s.phase === "countdown") status = `Round ${s.round}: get ready`;
  else if (s.phase === "playing") {
    if (!p || p.spectator) status = "Watching";
    else if (!head) status = "Sitting this round out";
    else if (!head.alive) status = "You crashed";
    else status = `Round ${s.round}: stay alive!`;
  } else if (s.phase === "roundover") status = "Round over";
  else if (s.phase === "gameover") status = "Game over";
  const color = p && !p.spectator ? p.color : "";
  const html = `${color ? `<span class="chip" style="background:${color}"></span>` : ""}<span class="who">${esc(status)}</span>`;
  const el = $("hud-status");
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
  $("hud-alive").textContent = round ? `${round.aliveCount}/${round.heads.length}` : "—";
  const extra = p ? (livePoints().get(p.id) ?? 0) : 0;
  $("hud-score").innerHTML = p && !p.spectator ? `${p.score}${extra ? ` <small>+${extra}</small>` : ""}` : "—";
  $("hud-target").innerHTML = s.target ? `${s.target} <small class="dim">lead ${WIN_LEAD}</small>` : "—";
  $("hud-round").textContent = s.round ? String(s.round) : "—";
}

function renderPlayers(s: GameState): void {
  const live = livePoints();
  const r =app.play && app.play.num === s.round ? app.play.round : null;
  const total = (p: PlayerState) => p.score + (live.get(p.id) ?? 0);
  const ranked = s.players.filter((p) => !p.spectator).sort((a, b) => total(b) - total(a) || rankPlayers(a, b));
  const top = ranked[0] ? total(ranked[0]) : 0;
  const rows = ranked.map((p, i) => {
    const head = r?.heads[r.index(p.id)];
    const extra = live.get(p.id) ?? 0;
    const cls = [
      i === 0 && top > 0 && (ranked[1] ? total(ranked[1]) < top : true) ? "leader" : "",
      isLive(s) && r && head && !head.alive ? "out" : "",
      isLive(s) && r && !head ? "sitting" : "",
      !p.cpu && !p.connected ? "offline" : "",
    ].join(" ");
    const tag = p.id === app.me ? ` <span class="tag tag-you">you</span>` : p.cpu ? ` <span class="tag">CPU</span>` : "";
    const lead = total(p) - Math.max(0, ...ranked.filter((o) => o !== p).map(total));
    const note =
      s.target && total(p) >= s.target && lead < WIN_LEAD && s.phase !== "gameover"
        ? `<span class="note">Match point: needs a ${WIN_LEAD}-point lead</span>`
        : "";
    return `<li class="${cls}">
      <span class="chip" style="background:${p.color}"></span>
      <span class="pname">${esc(p.name)}${tag}</span>
      <span class="pts">${p.score}${extra ? `<small>+${extra}</small>` : ""}</span>${note}
    </li>`;
  });
  const spectators = s.players.filter((p) => p.spectator);
  if (spectators.length) {
    rows.push(`<li class="muted" style="display:block">Watching: ${spectators.map((p) => esc(p.name)).join(", ")}</li>`);
  }
  $("game-players").innerHTML = rows.join("");
  $("side-target").textContent = s.target ? `first to ${s.target}` : "";
}

function renderWaiting(s: GameState): void {
  const p = me(s);
  const head = myHead();
  let text = "";
  if (p?.spectator) {
    text = "You joined during a match, so you're watching. You'll get a line when the host starts the next one.";
  } else if (isLive(s) && app.play && !head) {
    text = "You were offline when this round started, so you're sitting it out. You'll be back in the next round.";
  } else if (s.phase === "playing" && head && !head.alive) {
    text = "You crashed. The round goes on until one player is left; everyone still alive gets a point for each crash.";
  }
  const el = $("waiting");
  el.hidden = !text;
  el.textContent = text;
}

function flashBanner(html: string, ms: number): void {
  app.bannerUntil = performance.now() + ms;
  const el = $("banner");
  el.innerHTML = html;
  el.classList.add("flash");
  el.hidden = false;
}

function renderBanner(s: GameState): void {
  const el = $("banner");
  if (s.phase === "countdown") {
    // No box: the spawn points and arrows underneath need to stay visible.
    el.classList.remove("flash");
    el.classList.add("bare");
    const head = myHead();
    const sub = head?.alive ? "Yours is the one with the white ring" : "Get ready…";
    el.innerHTML = `<span class="big">Round ${s.round}</span><span class="count" data-countdown></span><span class="sub">${sub}</span>`;
    el.hidden = false;
    return;
  }
  el.classList.remove("bare");
  if (s.phase === "roundover") {
    el.classList.remove("flash");
    const winner = playerById(s.roundWinnerId);
    const head = winner
      ? `<span class="big" style="color:${winner.color}">${esc(winner.name)} wins round ${s.round}</span>`
      : `<span class="big">Round ${s.round}: nobody survived</span>`;
    const champ = playerById(s.winnerId);
    const next = champ
      ? `<b style="color:${champ.color}">${esc(champ.name)} wins the match!</b>`
      : `Next round in <span data-countdown></span>s`;
    el.innerHTML = `${head}${next}`;
    el.hidden = false;
    return;
  }
  if (app.bannerUntil) return; // transient banner still showing
  el.hidden = true;
}

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover";
  $("gameover").hidden = !open;
  if (!open) return;
  const ranked = s.players.filter((p) => !p.spectator).sort(rankPlayers);
  const champ = playerById(s.winnerId) ?? ranked[0];
  $("gameover-winner").innerHTML = champ ? `<b style="color:${champ.color}">${esc(champ.name)}</b> wins!` : "";
  $("gameover-rows").innerHTML = ranked
    .map(
      (p, i) => `<tr>
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${p.color}"></span>${esc(p.name)}</span></td>
        <td>${p.score}</td><td>${p.wins}</td></tr>`,
    )
    .join("");
  const back = $<HTMLButtonElement>("gameover-lobby");
  const host = canHost(s);
  back.disabled = !host;
  back.textContent = host ? "Back to lobby" : `Waiting for ${playerById(s.hostId)?.name ?? "host"}…`;
}

// ------------------------------------------------------------------ log & chat

function renderLog(): void {
  const html = app.log
    .map((e) =>
      e.kind === "chat"
        ? `<li><span class="who" style="color:${e.color ?? "inherit"}">${esc(e.from ?? "?")}:</span> ${esc(e.text)}</li>`
        : `<li class="ev">${esc(e.text)}</li>`,
    )
    .join("");
  for (const ol of $$("[data-log]")) {
    const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
    ol.innerHTML = html;
    if (atBottom) ol.scrollTop = ol.scrollHeight;
  }
}

// ------------------------------------------------------------------ layout

function layoutStage(): void {
  const col = document.querySelector<HTMLElement>(".stage-col")!;
  // Keep the whole arena on screen: cap its width by the height left below the HUD.
  // Twice, since a narrower column can wrap the HUD onto another line.
  col.style.margin = "0 auto";
  col.style.width = "100%";
  for (let pass = 0; pass < 2; pass++) {
    const stageTop = $("stage").getBoundingClientRect().top + window.scrollY;
    const maxByHeight = (window.innerHeight - stageTop - 12) * 1.6;
    col.style.maxWidth = `${Math.max(280, Math.round(maxByHeight))}px`;
  }
  renderer.resize($("stage").clientWidth || col.clientWidth);
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  window.addEventListener("popstate", route);
  window.addEventListener("resize", () => (app.screen === "home" ? attract.resize() : layoutStage()));
  new ResizeObserver(() => app.screen === "game" && renderer.resize($("stage").clientWidth)).observe($("stage"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") app.conn?.nudge();
  });
  for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, unlockAudio, { passive: true });

  // Home
  $("home-name").addEventListener("change", (e) => store("cb.name", (e.target as HTMLInputElement).value.trim()));
  $("home-create").addEventListener("click", () => void createGame());
  $("home-join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (readName()) void joinGame($<HTMLInputElement>("home-code").value.trim());
  });
  $("home-code").addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  $("home-join-invite-btn").addEventListener("click", (e) => {
    if (readName()) void joinGame((e.currentTarget as HTMLElement).dataset.code ?? "");
  });
  $("home-not-this").addEventListener("click", () => {
    history.pushState(null, "", BASE);
    showHome(null);
  });

  // Shared
  for (const b of $$("[data-action=leave]")) b.addEventListener("click", leave);
  for (const form of $$<HTMLFormElement>("[data-chat]")) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = form.querySelector("input")!;
      const text = input.value.trim();
      if (text) app.conn?.send({ t: "chat", text });
      input.value = "";
    });
    // Escape hands the keyboard back to the game.
    form.querySelector("input")!.addEventListener("keydown", (e) => {
      if (e.key === "Escape") (e.target as HTMLElement).blur();
    });
  }

  // Lobby
  $("lobby-copy").addEventListener("click", async () => {
    const link = $<HTMLInputElement>("lobby-link");
    try {
      await navigator.clipboard.writeText(link.value);
      toast("Invite link copied", "info");
    } catch {
      link.select();
      toast("Press Ctrl+C / ⌘C to copy", "info");
    }
  });
  $("lobby-players").addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-kick]")?.dataset.kick;
    if (id) app.conn?.send({ t: "kick", id });
  });
  $("lobby-cpu").addEventListener("click", (e) => {
    const level = (e.target as HTMLElement).closest<HTMLElement>("[data-cpu]")?.dataset.cpu;
    if (level) app.conn?.send({ t: "addCpu", level: level as "easy" | "normal" | "hard" });
  });
  $("lobby-colors").addEventListener("click", (e) => {
    const color = (e.target as HTMLElement).closest<HTMLElement>("[data-color]")?.dataset.color;
    if (color) app.conn?.send({ t: "color", color });
  });
  $("lobby-settings").addEventListener("change", (e) => {
    const el = e.target as HTMLSelectElement;
    const key = el.dataset.setting as keyof Settings | undefined;
    if (!key) return;
    const value = key === "target" ? Number(el.value) : el.value;
    app.conn?.send({ t: "settings", settings: { [key]: value } });
  });
  $("lobby-start").addEventListener("click", () => {
    unlockAudio();
    app.conn?.send({ t: "start" });
  });

  // Game
  $("gameover-lobby").addEventListener("click", () => app.conn?.send({ t: "lobby" }));
  const mute = $("mute");
  const paintMute = () => {
    mute.textContent = isMuted() ? "🔇" : "🔊";
    mute.setAttribute("aria-pressed", String(isMuted()));
  };
  mute.addEventListener("click", () => {
    setMuted(!isMuted());
    paintMute();
  });
  // Clicking the mute button shouldn't leave it focused.
  mute.addEventListener("mousedown", (e) => e.preventDefault());
  paintMute();
}

wire();
route();
requestAnimationFrame(frame);
