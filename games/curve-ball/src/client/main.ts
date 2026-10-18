import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import { $, $$, esc } from "@warrick/kit/client/dom";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { SUBSTEPS, TICK_MS, WIN_LEAD, type Speed } from "../shared/constants";
import {
  SETTING_CHOICES,
  autoTarget,
  rankPlayers,
  type ClientMsg,
  type FrameMsg,
  type GameState,
  type PlayerState,
  type RoundSnapshot,
  type ServerMsg,
} from "../shared/protocol";
import { Round, coast, type Steer } from "../shared/sim";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { Steering } from "./input";
import { Renderer, type HeadStyle, type Prediction } from "./render";

// ------------------------------------------------------------------ helpers

const touchScreen = window.matchMedia("(pointer: coarse)").matches;
/** Draw your own head ahead of the server. `?predict=0` turns it off, to compare. */
const predicting = new URLSearchParams(location.search).get("predict") !== "0";

// ------------------------------------------------------------------ app state

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
  play: null as Play | null,
  bannerUntil: 0,
  lastFrame: 0,
  lastCount: -1,
  /** The state being applied came with a welcome (joining or reconnecting). */
  welcomed: false,
  /** The game screen was just shown: lay it out again once the HUD has its contents. */
  relayout: false,
};

const SPEED_LABELS: Record<Speed, string> = { chill: "Chill", classic: "Classic", fast: "Fast" };

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "curve-ball",
  title: "Curve Ball",
  prefix: "cb",
  logo: "CURVE<br />BALL",
  tagline: "Steer, slip through the gaps, outlast everyone.<br />No accounts — just share a code.",
  placeholder: "Squiggler",
  footer: "A love letter to <em>Achtung, die Kurve!</em> (1995).",
  settings: {
    target: {
      label: "First to",
      fmt: (v: number) => (v === 0 ? `Auto: ${autoTarget(seated(shell.state))} points` : `${v} points`),
    },
    speed: { label: "Speed", fmt: (v: Speed) => SPEED_LABELS[v] ?? String(v) },
  },
  choices: SETTING_CHOICES,
  onWelcome,
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s): string | null =>
    s.phase !== "lobby" && s.phase !== "gameover" ? "Leave this game? You'll miss the rest of the match." : null,
  isLive: (s) => isLive(s),
});
const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));
const steering = new Steering(canSteer, sendSteer);

const serverNow = () => shell.serverNow();
const me = (s = shell.state): PlayerState | undefined => s?.players.find((p) => p.id === shell.me);
const playerById = (id: string | null | undefined) => shell.player(id);
const canHost = (s = shell.state) => shell.canHost(s);
const isLive = (s = shell.state) => !!s && (s.phase === "countdown" || s.phase === "playing");
const seated = (s: GameState | null) => s?.players.filter((p) => !p.spectator).length ?? 0;

/** My head in the round on screen, if I have one. */
function myHead() {
  const r = app.play?.round;
  const i = r ? r.index(shell.me) : -1;
  return i >= 0 ? r!.heads[i] : null;
}

/** Points earned so far in the round on screen, by player id. Already counted in scores once it's over. */
function livePoints(): Map<string, number> {
  const out = new Map<string, number>();
  const s = shell.state;
  const p = app.play;
  if (!s || !p || !isLive(s) || p.num !== s.round) return out;
  for (const h of p.round.heads) out.set(h.id, h.points);
  return out;
}

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "game") {
    layoutStage();
    app.relayout = true;
  }
  if (screen === "home") attract.resize();
}

/** Left the game, or lost it for good. */
function onReset(): void {
  app.play = null;
  steering.releaseAll();
  $("gameover").hidden = true;
}

// ------------------------------------------------------------------ messages

function onWelcome(msg: ServerMsg): void {
  if (msg.t !== "welcome") return;
  app.welcomed = true;
  setRound(msg.round, msg.state);
}

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case "round":
      setRound(msg.round);
      render();
      break;
    case "f":
      onFrame(msg);
      break;
  }
}

function onState(s: GameState, prev: GameState | null): void {
  // A welcome's state isn't a change of phase: you've just (re)joined.
  const welcomed = app.welcomed;
  app.welcomed = false;
  if (s.phase === "lobby") app.play = null;
  if (prev && !welcomed && prev.phase !== s.phase) {
    if (s.phase === "playing") {
      sfx.go();
      flashBanner(`<span class="count">GO!</span>`, 700);
      // Hand the arrow keys to the game.
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.closest("input, select, button")) focused.blur();
    } else if (s.phase === "roundover") {
      steering.releaseAll();
      if (s.roundWinnerId === shell.me) sfx.win();
    } else if (s.phase === "countdown") {
      app.lastCount = -1;
    }
  }
  if (isLive(s) && myHead()?.alive) document.title = `▶ ${document.title}`;
  render();
  // Still holding a key from before a reconnect? Tell the server.
  if (welcomed && steering.value !== 0) sendSteer(steering.value);
}

/** Rebuild a round from its snapshot: replay every tick, drawing trails as it goes. */
function setRound(snap: RoundSnapshot | null, s = shell.state): void {
  if (!snap) {
    app.play = null;
    return;
  }
  const round = new Round(snap);
  renderer.reset(round);
  const styles = headStyles(round, s);
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
  shell.send({ t: "resync" });
}

function applyFrame(p: Play, f: FrameMsg): void {
  const { round } = p;
  const mine = round.index(shell.me);
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
    sfx.crash(h.id === shell.me);
  }
  const expected = (f.d ?? []).join();
  if (deaths.map((d) => d.slot).join() !== expected || (f.c !== undefined && f.c !== round.checksum())) {
    resync(p);
  }
  if (deaths.length && shell.state) renderGame(shell.state);
}

function headStyles(round: Round, s = shell.state): HeadStyle[] {
  return round.heads.map((h) => {
    const p = s?.players.find((o) => o.id === h.id);
    return { name: p?.name ?? "?", color: p?.color ?? "#ffffff", you: h.id === shell.me };
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
  if (shell.screen !== "game" || !isLive()) return false;
  return !!myHead()?.alive;
}

function sendSteer(s: Steer): void {
  const now = performance.now();
  steerHistory.push([now, s]);
  while (steerHistory.length > 2 && steerHistory[1][0] < now - 2000) steerHistory.shift();
  if (!canSteer() && s !== 0) return;
  if (shell.send({ t: "steer", s }) && shell.state?.phase === "playing") {
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
  if (shell.state?.phase !== "playing") return null;
  const { round } = p;
  const slot = round.index(shell.me);
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
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game") return;

  const p = app.play;
  if (p) advance(p, dt);
  const alpha = p ? p.clock - (p.round.tick - 1) : 1;
  renderer.draw(p?.round ?? null, {
    styles: p ? headStyles(p.round) : [],
    alpha,
    labels: shell.state?.phase === "countdown",
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
  const s = shell.state;
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

/** The shell has already shown the right screen and drawn the lobby. */
function render(): void {
  const s = shell.state;
  if (!s || shell.screen === "home") return;
  if (s.phase === "lobby") {
    renderLobbyNotes(s);
  } else if (shell.screen === "game") {
    renderGame(s);
    if (app.relayout) {
      // Again, now that the HUD has its contents and its real height.
      app.relayout = false;
      layoutStage();
    }
  }
}

// ------------------------------------------------------------------ lobby

/** Curve Ball's lobby has a "How to play" panel and a few notes beyond the kit's. */
function mountLobbyExtras(): void {
  $("lobby-cpu").insertAdjacentHTML("afterend", `<p id="lobby-full" class="hint" hidden></p>`);
  $("lobby-settings").insertAdjacentHTML("afterend", `<p id="lobby-settings-note" class="hint"></p>`);
  document.querySelector("#screen-lobby .chat-panel")!.insertAdjacentHTML(
    "beforebegin",
    `<div class="panel how-panel">
      <div class="panel-head"><h2>How to play</h2></div>
      <ul class="how">
        <li>Your line never stops. Steer with <kbd>←</kbd><kbd>→</kbd> or <kbd>A</kbd><kbd>D</kbd>, or hold the left or right half of the screen.</li>
        <li>Hit a wall or any trail, including your own, and you're out.</li>
        <li>Every so often your trail leaves a gap. Anyone can slip through it.</li>
        <li>Each time someone crashes, everyone still alive gets a point.</li>
      </ul>
    </div>`,
  );
}

function renderLobbyNotes(s: GameState): void {
  const host = canHost(s);
  const participants = s.players.filter((p) => !p.spectator);
  const full = participants.length >= MAX_PLAYERS;
  const fullNote = $("lobby-full");
  fullNote.hidden = !full;
  fullNote.textContent = host
    ? `The game is full (${MAX_PLAYERS}/${MAX_PLAYERS}). Remove someone to make room.`
    : `The game is full (${MAX_PLAYERS}/${MAX_PLAYERS}). Anyone else who joins will watch.`;

  const offline = s.players.some((p) => !p.cpu && !p.connected);
  $("lobby-settings-note").innerHTML = [
    `To win you also need a ${WIN_LEAD}-point lead.`,
    host ? "" : "Only the host can change settings.",
    offline ? "Offline players are removed when the game starts." : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (host && participants.length < 2) {
    $("lobby-wait").textContent = "You need at least two players to start. Invite a friend or add a CPU.";
  }
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
    const tag = p.id === shell.me ? ` <span class="tag tag-you">you</span>` : p.cpu ? ` <span class="tag">CPU</span>` : "";
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
  window.addEventListener("resize", () => (shell.screen === "home" ? attract.resize() : layoutStage()));
  new ResizeObserver(() => shell.screen === "game" && renderer.resize($("stage").clientWidth)).observe($("stage"));
  // Escape hands the keyboard back to the game.
  for (const input of $$<HTMLInputElement>("[data-chat] input")) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") input.blur();
    });
  }
}

mountLobbyExtras();
wire();
shell.start();
requestAnimationFrame(frame);
