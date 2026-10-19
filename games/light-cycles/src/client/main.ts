import { unlockAudio } from "@warrick/kit/client/audio";
import { $, $$, esc, setHtml, setText } from "@warrick/kit/client/dom";
import { formatClock } from "@warrick/kit/client/format";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { Arena, type ArenaEvent, type ArenaSnapshot, type Cycle, type Dir, type Frame, type WallMode } from "../shared/arena";
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
import { Playback } from "./playback";
import { Predictor, type Predicted } from "./predict";
import { Renderer, type DrawOpts, type RiderInfo } from "./render";

// ------------------------------------------------------------------ helpers

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ------------------------------------------------------------------ app state

const app = {
  /** The round on screen, kept in step by the server's frames as playback reaches them. */
  arena: null as Arena | null,
  /** The frames on their way to the screen, played back on the server's schedule. */
  playback: new Playback(),
  /** The newest frame, and your cycle run on from it, so it steers the moment you press. */
  predictor: new Predictor(),
  /** Your cycle as drawn this animation frame, while a round is being ridden. */
  ahead: null as Predicted | null,
  /** When the last animation frame ran. */
  lastNow: 0,
  /** The state being applied came with a welcome (joining or reconnecting), not a change of phase. */
  welcomed: false,
  bannerUntil: 0,
  lastCount: 0,
  swipe: null as { x: number; y: number; dir: Dir | null } | null,
};

/** No animation frame for this long (in ms) means the page isn't animating: it's in a hidden pane, say. */
const STILL_MS = 250;

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
  setArena(null);
  $("gameover").hidden = true;
}

// ------------------------------------------------------------------ messages

function onWelcome(msg: ServerMsg): void {
  if (msg.t !== "welcome") return;
  app.welcomed = true;
  setArena(msg.arena, msg.state);
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

function setArena(snap: ArenaSnapshot | null, s = shell.state): void {
  app.arena = snap ? new Arena(snap) : null;
  app.playback.reset(app.arena?.tick ?? 0);
  app.predictor.reset(snap, tickMsFor(s?.settings.speed ?? "classic"));
  app.ahead = null;
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
      app.predictor.started(performance.now());
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
  const now = performance.now();
  if (!app.arena || !app.predictor.frame(f, shell.me, now)) return;
  app.playback.push(f);
  // A background tab or a hidden pane doesn't animate, so keep its round current rather than queueing.
  if (document.hidden || now - app.lastNow > STILL_MS) drain();
  else crashAhead(f, now);
}

/**
 * Your own crash shows as soon as it's heard, while everyone else plays on at their own pace.
 * Your cycle runs ahead of playback (see `Predictor`), so it would otherwise sit at the wall
 * until playback caught up. When playback gets to this frame, it doesn't show the crash again.
 */
function crashAhead(f: Frame, now: number): void {
  const a = app.arena!;
  for (const ev of f.e) {
    if (ev.k !== "crash" || a.cycles[ev.i]?.id !== shell.me || !a.cycles[ev.i].alive) continue;
    const c = app.predictor.arena?.cycles[ev.i];
    if (!c) return;
    a.crashAs(ev.i, c);
    showEvents([ev], now);
  }
}

/** Show the frames playback has reached (see `Playback`). */
function advance(now: number): void {
  if (!app.arena) return;
  for (const f of app.playback.advance(now, app.predictor.clock)) applyFrame(f, now);
}

/** Show every buffered frame now. */
function drain(): void {
  const now = performance.now();
  for (const f of app.playback.drain()) applyFrame(f, now);
}

function applyFrame(f: Frame, now: number): void {
  const a = app.arena!;
  // A crash shown already isn't shown again: yours shows as soon as it comes in (see `crashAhead`).
  const events = f.e.filter((ev) => ev.k !== "crash" || a.cycles[ev.i]?.alive);
  renderer.beforeFrame(a, now);
  a.apply(f);
  showEvents(events, now);
}

/** The sparks, sounds and banners for what happened in a tick, once it's in the arena on screen. */
function showEvents(events: ArenaEvent[], now: number): void {
  const a = app.arena!;
  renderer.afterFrame(a, events, now, (id) => playerById(id)?.color ?? "#ffffff", shell.me);
  if (!events.length) return;
  for (const ev of events) {
    if (ev.k === "crash") {
      const mine = a.cycles[ev.i].id === shell.me;
      sfx.crash(mine);
      if (mine) flashBanner(`<span class="big">DEREZZED</span>Hang tight for the next round`, 1800);
    } else if (ev.k === "shrink" && ev.s === 1) {
      flashBanner(`<span class="big">SUDDEN DEATH</span>The walls are closing in`, 1800);
    }
  }
  if (shell.state) renderGame(shell.state);
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  app.lastNow = now;
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game") return;
  advance(now);
  const s = shell.state;
  app.ahead = s?.phase === "playing" ? app.predictor.predict(shell.me, now, shell.rtt) : null;
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
    alpha: app.playback.alpha,
    turn: s.phase === "countdown" ? app.predictor.next : null,
    ahead: app.ahead,
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
    setText(clock, text);
    clock.title = a?.cfg.suddenDeathAt && isLive(s) ? "Time until the walls close in" : "";
    clock.classList.toggle("low", cls === "low");
    clock.classList.toggle("sd", cls === "sd");
  }
  renderBoost();
  if (s.phase === "countdown") renderBanner();
  else app.lastCount = 0;
  if (s.phase === "roundover") {
    const secs = s.phaseDeadline ? Math.max(0, Math.ceil((s.phaseDeadline - serverNow()) / 1000)) : 0;
    for (const el of $$("[data-countdown]")) setText(el, String(secs));
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
  setHtml($("hud-status"), html);
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
  const cyc = app.ahead?.cycle ?? myCycle();
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
        live && !cyc?.alive ? "out" : "",
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
  setHtml(el, html);
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

/** Turns and boosts are sent for the tick your screen shows them on: see `Predictor`. */
function steer(dir: Dir): void {
  const cyc = myCycle();
  if (!isLive() || !cyc?.alive) return;
  unlockAudio();
  const at = app.predictor.aimTurn(shell.me, dir, performance.now(), shell.rtt);
  if (at === null || !shell.send({ t: "turn", dir, at })) return;
  app.predictor.sentTurn(dir, at);
  sfx.turn();
}

function boost(): void {
  const cyc = app.ahead?.cycle ?? myCycle();
  if (shell.state?.phase !== "playing" || !cyc?.alive || cyc.boosts <= 0 || cyc.boost > 0) return;
  unlockAudio();
  const at = app.predictor.aimBoost(shell.me, performance.now(), shell.rtt);
  if (at === null || !shell.send({ t: "boost", at })) return;
  app.predictor.sentBoost(at);
  sfx.boost();
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
