import { unlockAudio } from "@warrick/kit/client/audio";
import { $, $$, esc } from "@warrick/kit/client/dom";
import { formatClock } from "@warrick/kit/client/format";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { Arena, type ArenaSnapshot, type Cycle, type Dir, type Frame, type WallMode } from "../shared/arena";
import { PLAYER_COLORS, tickMsFor, type ArenaSize, type Speed } from "../shared/constants";
import {
  SETTING_CHOICES,
  rankPlayers,
  type ClientMsg,
  type GameState,
  type PlayerState,
  type ServerMsg,
} from "../shared/protocol";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { Renderer, type DrawOpts, type RiderInfo } from "./render";
import { TurnCue } from "./turns";

// ------------------------------------------------------------------ helpers

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ------------------------------------------------------------------ app state

const app = {
  /** The round on screen, kept in step by the server's frames. */
  arena: null as Arena | null,
  /** Frames received but not shown yet, oldest first. */
  frames: [] as Frame[],
  /** Where playback is, in ticks. It trails the newest frame a little to smooth out network jitter. */
  clock: 0,
  /** Turns you've sent that no frame has shown yet. */
  turns: new TurnCue(),
  lastNow: 0,
  /** The state being applied came with a welcome (joining or reconnecting), not a change of phase. */
  welcomed: false,
  bannerUntil: 0,
  lastCount: 0,
  swipe: null as { x: number; y: number; dir: Dir | null } | null,
};

/**
 * Playback runs in real time and never passes the newest frame, so it shows each frame about a
 * tick after it arrives. Further behind than this, in ticks (frames came in a bunch), it speeds up.
 */
const BUFFER_TICKS = 1.5;
/** Further behind than this (say, the tab was in the background) and playback skips ahead. */
const MAX_BEHIND_TICKS = 30;

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "light-cycles",
  title: "Light Cycles",
  prefix: "lc",
  logo: "LIGHT<br />CYCLES",
  tagline: "Real-time light cycle duels for friends.<br />No accounts — just share a code.",
  placeholder: "Rider",
  footer: "A love letter to the light cycles of <em>Tron</em> (1982).",
  playersLabel: "Riders",
  colors: PLAYER_COLORS,
  settings: {
    rounds: { label: "Rounds", fmt: (v: number) => String(v) },
    arena: {
      label: "Arena",
      fmt: (v: ArenaSize) => ({ small: "Small — 80×45", medium: "Medium — 112×63", large: "Large — 144×81" })[v] ?? v,
    },
    speed: { label: "Speed", fmt: (v: Speed) => ({ chill: "Chill", classic: "Classic", hyper: "Hyper" })[v] ?? v },
    boosts: { label: "Boosts", fmt: (v: number) => (v ? `${v} per round` : "Off") },
    walls: { label: "Walls", fmt: (v: WallMode) => ({ solid: "Solid — crash on contact", wrap: "Wrap-around" })[v] ?? v },
    suddenDeath: { label: "Sudden death", fmt: (v: number) => (v ? `Walls close after ${v}s` : "Off") },
  },
  choices: SETTING_CHOICES,
  onWelcome,
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s): string | null =>
    s.phase !== "lobby" && s.phase !== "gameover" ? "Leave this game? Your cycle rides on without you." : null,
  isLive: (s) => isLive(s),
});
const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));
const coarse = window.matchMedia("(pointer: coarse)");

const serverNow = () => shell.serverNow();
const me = (s = shell.state): PlayerState | undefined => s?.players.find((p) => p.id === shell.me);
const playerById = (id: string | null | undefined) => shell.player(id);
const myCycle = (): Cycle | null => {
  const i = app.arena?.index(shell.me) ?? -1;
  return i >= 0 ? app.arena!.cycles[i] : null;
};
const canHost = (s = shell.state) => shell.canHost(s);

function isLive(s = shell.state): boolean {
  return !!s && (s.phase === "countdown" || s.phase === "playing");
}

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "game") layoutStage();
  if (screen === "home") attract.resize();
}

/** Left the game, or lost it for good. */
function onReset(): void {
  app.arena = null;
  app.frames = [];
  $("gameover").hidden = true;
}

// ------------------------------------------------------------------ messages

function onWelcome(msg: ServerMsg): void {
  if (msg.t !== "welcome") return;
  app.welcomed = true;
  setArena(msg.arena);
}

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case "arena":
      setArena(msg.arena);
      render();
      break;
    case "frame":
      onFrame(msg.f);
      break;
  }
}

function setArena(snap: ArenaSnapshot | null): void {
  app.arena = snap ? new Arena(snap) : null;
  app.frames = [];
  app.clock = app.arena?.tick ?? 0;
  app.turns.clear();
  if (app.arena) renderer.reset(app.arena);
}

/** The shell has shown the lobby or the game screen (and drawn the lobby). */
function onState(s: GameState, prev: GameState | null): void {
  // A welcome's state isn't a change of phase: you've just (re)joined, so don't replay its effects.
  const welcomed = app.welcomed;
  app.welcomed = false;
  if (s.phase === "lobby") setArena(null);
  // The round just ended: show its last frames before the result.
  if (s.phase !== "playing") drain();
  if (prev && !welcomed && prev.phase !== s.phase) {
    if (s.phase === "playing") {
      sfx.go();
      flashBanner(`<span class="count">GO!</span>`, 700, "count-banner");
    } else if (s.phase === "roundover" && s.roundWinnerId === shell.me) {
      sfx.win();
    }
  }
  document.title = isLive(s) && myCycle()?.alive ? `▶ Riding — Light Cycles` : `Light Cycles · ${s.code}`;
  render();
}

function onFrame(f: Frame): void {
  const a = app.arena;
  if (!a || f.n <= (app.frames.at(-1)?.n ?? a.tick)) return;
  app.frames.push(f);
  // A background tab doesn't animate, so keep its round current rather than queueing.
  if (document.hidden) drain();
}

/**
 * Play buffered frames in real time, a little behind the newest one, so a late frame or two
 * arriving together don't make the heads stall and jump. Playback speeds up when it falls behind.
 */
function advance(now: number): void {
  const dt = app.lastNow ? Math.min(250, now - app.lastNow) : 0;
  app.lastNow = now;
  const a = app.arena;
  const s = shell.state;
  if (!a || !s) return;
  const newest = app.frames.at(-1)?.n ?? a.tick;
  const behind = newest - app.clock;
  if (behind > MAX_BEHIND_TICKS) app.clock = newest - BUFFER_TICKS;
  else app.clock += (dt / tickMsFor(s.settings.speed)) * (1 + Math.max(0, behind - BUFFER_TICKS) * 0.5);
  if (app.clock > newest) app.clock = newest;
  while (app.frames.length && app.frames[0].n <= app.clock) applyFrame(app.frames.shift()!, now);
}

/** Show every buffered frame now. */
function drain(): void {
  const now = performance.now();
  while (app.frames.length) applyFrame(app.frames.shift()!, now);
  if (app.arena) app.clock = app.arena.tick;
}

function applyFrame(f: Frame, now: number): void {
  const a = app.arena!;
  const mine = a.cycles[a.index(shell.me)];
  const before = mine?.dir;
  renderer.beforeFrame(a, now);
  a.apply(f);
  if (mine && before !== undefined) app.turns.shown(before, mine.dir, f.n);
  renderer.afterFrame(a, f, now, (id) => playerById(id)?.color ?? "#ffffff", shell.me);
  if (!f.e.length) return;
  for (const ev of f.e) {
    if (ev.k === "crash") {
      const mine = a.cycles[ev.i].id === shell.me;
      sfx.crash(mine);
      if (mine) flashBanner(`<span class="big">DEREZZED</span>Hang tight for the next round`, 1800);
    } else if (ev.k === "boost") {
      if (a.cycles[ev.i].id === shell.me) sfx.boost();
    } else if (ev.k === "shrink" && ev.s === 1) {
      flashBanner(`<span class="big">SUDDEN DEATH</span>The walls are closing in`, 1800);
    }
  }
  if (shell.state) renderGame(shell.state);
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game") return;
  advance(now);
  const s = shell.state;
  if (app.arena && s) renderer.draw(app.arena, drawOpts(s), now);
  tickClocks();
}

function drawOpts(s: GameState): DrawOpts {
  const riders = new Map<string, RiderInfo>();
  for (const p of s.players) riders.set(p.id, { name: p.name, color: p.color, you: p.id === shell.me });
  return {
    theme: s.theme,
    riders,
    labels: s.phase === "countdown",
    tickMs: tickMsFor(s.settings.speed),
    turn: isLive(s) ? app.turns.next : null,
  };
}

function tickClocks(): void {
  const s = shell.state;
  if (!s) return;
  const a = app.arena;
  const clock = document.querySelector<HTMLElement>("#hud-status .clock");
  if (clock) {
    let text = "";
    let cls = "";
    if (a && isLive(s)) {
      const tps = 1000 / tickMsFor(s.settings.speed);
      const sd = a.cfg.suddenDeathAt;
      if (!sd) text = formatClock((a.tick / tps) * 1000);
      else if (a.tick >= sd) [text, cls] = ["SUDDEN DEATH", "sd"];
      else {
        const left = ((sd - a.tick) / tps) * 1000;
        text = formatClock(left);
        if (left < 10000) cls = "low";
      }
    }
    if (clock.textContent !== text) clock.textContent = text;
    clock.title = a?.cfg.suddenDeathAt && isLive(s) ? "Time until the walls close in" : "";
    clock.classList.toggle("low", cls === "low");
    clock.classList.toggle("sd", cls === "sd");
  }
  renderBoost();
  if (s.phase === "countdown") renderBanner();
  else app.lastCount = 0;
  if (s.phase === "roundover") {
    const secs = s.phaseDeadline ? Math.max(0, Math.ceil((s.phaseDeadline - serverNow()) / 1000)) : 0;
    for (const el of $$("[data-countdown]")) {
      const text = String(secs);
      if (el.textContent !== text) el.textContent = text;
    }
  }
  if (app.bannerUntil && performance.now() > app.bannerUntil) {
    app.bannerUntil = 0;
    renderBanner();
  }
}

// ------------------------------------------------------------------ rendering: top level

function render(): void {
  const s = shell.state;
  if (s && shell.screen === "game") renderGame(s);
}

// ------------------------------------------------------------------ game

function renderGame(s: GameState): void {
  renderHud(s);
  renderPlayers(s);
  renderControls(s);
  renderBanner();
  renderGameOver(s);
}

function renderHud(s: GameState): void {
  const p = me(s);
  const cyc = myCycle();
  let who = "";
  if (s.phase === "countdown") who = cyc ? "Get ready…" : "Round starting…";
  else if (s.phase === "playing") who = cyc?.alive ? "Ride!" : cyc ? "Derezzed — watching" : "Watching";
  else if (s.phase === "roundover") who = "Round over";
  else if (s.phase === "gameover") who = "Game over";
  const chip = p && !p.spectator ? `<span class="chip" style="background:${p.color}"></span>` : "";
  const html = `${chip}<span class="who">${who}</span><span class="clock"></span>`;
  const status = $("hud-status");
  if (status.dataset.html !== html) {
    status.innerHTML = html;
    status.dataset.html = html;
  }
  const a = app.arena;
  $("hud-riders").textContent = a ? `${a.aliveCount}/${a.cycles.length}` : "—";
  $("hud-score").textContent = p && !p.spectator ? String(p.score) : "—";
  $("hud-round").textContent = s.round ? `${s.round}/${s.settings.rounds}` : "—";
  renderBoost();
}

/** Boost pips change as a boost burns down, so this runs every animation frame. */
function renderBoost(): void {
  const s = shell.state;
  const el = $("hud-boost");
  if (!s) return;
  const cyc = myCycle();
  const total = s.settings.boosts;
  const key = !total ? "off" : cyc ? `${cyc.boosts}:${cyc.boost > 0}:${cyc.alive}` : "none";
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  if (!total) el.textContent = "Off";
  else if (!cyc?.alive) el.textContent = "—";
  else {
    const pips = [];
    for (let i = 0; i < total; i++) {
      const cls = i < cyc.boosts ? "on" : i === cyc.boosts && cyc.boost > 0 ? "live" : "";
      pips.push(`<i class="${cls}"></i>`);
    }
    el.innerHTML = pips.join("");
  }
  const btn = $<HTMLButtonElement>("pad-boost");
  btn.disabled = !(s.phase === "playing" && cyc?.alive && cyc.boosts > 0 && cyc.boost === 0);
}

function renderPlayers(s: GameState): void {
  const a = app.arena;
  const live = isLive(s);
  const rows = s.players
    .filter((p) => !p.spectator)
    .sort(rankPlayers)
    .map((p) => {
      const i = a?.index(p.id) ?? -1;
      const cyc = i >= 0 ? a!.cycles[i] : null;
      let status = "";
      let riding = false;
      if (live && cyc) [status, riding] = cyc.alive ? ["Riding", true] : ["Derezzed", false];
      else if (live) status = "Sitting out";
      else if (s.phase === "roundover" && s.roundWinnerId === p.id) status = `Won round ${s.round}`;
      const record = [plural(p.wins, "win"), plural(p.kills, "kill")].join(" · ");
      const cls = [
        p.id === shell.me ? "you" : "",
        s.phase === "roundover" && s.roundWinnerId === p.id ? "winner" : "",
        (live && cyc && !cyc.alive) || (!cyc && live) ? "out" : "",
        !p.cpu && !p.connected ? "offline" : "",
      ].join(" ");
      const tag = p.id === shell.me ? ` <span class="tag tag-you">you</span>` : p.cpu ? ` <span class="tag">CPU</span>` : "";
      return `<li class="${cls}">
        <span class="chip" style="background:${p.color}"></span>
        <span class="pname">${esc(p.name)}${tag}</span>
        <span class="pts" title="Score">${p.score}</span>
        <span class="status ${riding ? "riding" : ""}">${status ? `${status} · ` : ""}${record}</span>
      </li>`;
    });
  const spectators = s.players.filter((p) => p.spectator);
  if (spectators.length) {
    rows.push(`<li class="muted" style="display:block">Watching: ${spectators.map((p) => esc(p.name)).join(", ")}</li>`);
  }
  $("game-players").innerHTML = rows.join("");
}

function renderControls(s: GameState): void {
  const p = me(s);
  const cyc = myCycle();
  const live = isLive(s);
  const pad = $("pad");
  const waiting = $("waiting");
  pad.hidden = !live || !cyc;
  pad.classList.toggle("disabled", !cyc?.alive);
  waiting.hidden = !live || !!cyc;
  if (live && !cyc) {
    waiting.textContent = p?.spectator
      ? "You're watching this game. You'll get a cycle when the host starts the next one."
      : "You're sitting this round out.";
  }
}

function flashBanner(html: string, ms: number, cls = ""): void {
  app.bannerUntil = performance.now() + ms;
  const el = $("banner");
  el.innerHTML = html;
  el.className = `banner flash ${cls}`;
  el.hidden = false;
}

function setBanner(html: string, cls = ""): void {
  const el = $("banner");
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
  el.className = `banner ${cls}`;
  el.hidden = false;
}

function renderBanner(): void {
  const s = shell.state;
  const el = $("banner");
  if (!s) return;
  if (s.phase === "countdown") {
    const secs = Math.max(1, Math.ceil(((s.phaseDeadline ?? 0) - serverNow()) / 1000));
    if (secs !== app.lastCount) {
      app.lastCount = secs;
      sfx.count();
    }
    const hint = myCycle()
      ? coarse.matches
        ? "Swipe or use the pad to steer"
        : "Arrows / WASD steer · Space boosts"
      : "Round starting";
    setBanner(`<span class="count">${secs}</span>${hint}`, "count-banner");
    return;
  }
  if (s.phase === "roundover") {
    const winner = playerById(s.roundWinnerId);
    const head = winner
      ? `<span class="big" style="color:${winner.color}">${esc(winner.name)} wins round ${s.round}</span>`
      : `<span class="big">Round ${s.round}: nobody made it</span>`;
    const next = s.round >= s.settings.rounds ? "Final results" : "Next round";
    setBanner(`${head}${next} in <span data-countdown></span>s`);
    return;
  }
  if (app.bannerUntil) return; // transient banner still showing
  el.hidden = true;
  delete el.dataset.html;
}

// ------------------------------------------------------------------ game over

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover";
  $("gameover").hidden = !open;
  if (!open) return;
  const ranked = s.players.filter((p) => !p.spectator).sort(rankPlayers);
  const best = ranked[0];
  $("gameover-winner").innerHTML = best ? `<b style="color:${best.color}">${esc(best.name)}</b> owns the grid.` : "";
  $("gameover-rows").innerHTML = ranked
    .map(
      (p, i) => `<tr>
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${p.color}"></span>${esc(p.name)}</span></td>
        <td>${p.score}</td><td>${p.wins}</td><td>${p.kills}</td></tr>`,
    )
    .join("");
  const back = $<HTMLButtonElement>("gameover-lobby");
  const host = canHost(s);
  back.disabled = !host;
  back.textContent = host ? "Back to lobby" : `Waiting for ${playerById(s.hostId)?.name ?? "host"}…`;
}

// ------------------------------------------------------------------ steering

function steer(dir: Dir): void {
  const cyc = myCycle();
  if (!isLive() || !cyc?.alive) return;
  unlockAudio();
  const newest = app.frames.at(-1)?.n ?? app.arena!.tick;
  if (shell.send({ t: "turn", dir }) && app.turns.send(dir, cyc.dir, newest)) sfx.turn();
}

function boost(): void {
  const cyc = myCycle();
  if (shell.state?.phase !== "playing" || !cyc?.alive || cyc.boosts <= 0 || cyc.boost > 0) return;
  unlockAudio();
  shell.send({ t: "boost" });
}

const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: 0,
  KeyW: 0,
  ArrowRight: 1,
  KeyD: 1,
  ArrowDown: 2,
  KeyS: 2,
  ArrowLeft: 3,
  KeyA: 3,
};

// ------------------------------------------------------------------ layout

function layoutStage(): void {
  const col = document.querySelector<HTMLElement>(".stage-col")!;
  // Keep everything on screen: cap the grid height to what's left of the viewport.
  const reserved = (window.innerWidth <= 760 ? 230 : 190) + (coarse.matches ? 210 : 0);
  const maxByHeight = ((window.innerHeight - reserved) * 16) / 9;
  col.style.maxWidth = `${Math.max(320, Math.round(maxByHeight))}px`;
  col.style.margin = "0 auto";
  col.style.width = "100%";
  renderer.resize($("stage").clientWidth || col.clientWidth);
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  window.addEventListener("resize", () => (shell.screen === "home" ? attract.resize() : layoutStage()));
  new ResizeObserver(() => shell.screen === "game" && renderer.resize($("stage").clientWidth)).observe($("stage"));

  // Steering: keyboard, the on-screen pad, and swipes on the grid.
  window.addEventListener("keydown", (e) => {
    if (shell.screen !== "game" || !isLive()) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, select, textarea")) return;
    const dir = KEY_DIRS[e.code];
    if (dir !== undefined) {
      e.preventDefault();
      if (!e.repeat) steer(dir);
    } else if (e.code === "Space" || e.key === "Shift") {
      e.preventDefault();
      if (!e.repeat) boost();
    }
  });
  for (const btn of $$<HTMLButtonElement>("[data-dir]")) {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      steer(Number(btn.dataset.dir) as Dir);
    });
  }
  $("pad-boost").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    boost();
  });

  const canvas = renderer.canvas;
  canvas.addEventListener("pointerdown", (e) => {
    if (!isLive()) return;
    app.swipe = { x: e.clientX, y: e.clientY, dir: null };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    const sw = app.swipe;
    if (!sw) return;
    const dx = e.clientX - sw.x;
    const dy = e.clientY - sw.y;
    if (Math.hypot(dx, dy) < 22) return;
    const dir: Dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
    // One gesture can carve several turns: each change of direction is a new turn.
    if (dir !== sw.dir) steer(dir);
    app.swipe = { x: e.clientX, y: e.clientY, dir };
  });
  for (const ev of ["pointerup", "pointercancel"]) canvas.addEventListener(ev, () => (app.swipe = null));
}

wire();
shell.start();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __lc: { app, shell, renderer } });
