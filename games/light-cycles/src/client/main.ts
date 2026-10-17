import { Arena, type ArenaSnapshot, type Cycle, type Dir, type Frame } from "../shared/arena";
import { CODE_RE, MAX_PLAYERS, PLAYER_COLORS, tickMsFor } from "../shared/constants";
import {
  SETTING_CHOICES,
  rankPlayers,
  type GameState,
  type LogEntry,
  type PlayerState,
  type ServerMsg,
  type Settings,
} from "../shared/protocol";
import { Attract } from "./attract";
import { isMuted, setMuted, sfx, unlockAudio } from "./audio";
import { Connection, type NetStatus } from "./net";
import { Renderer, type DrawOpts, type RiderInfo } from "./render";

// ------------------------------------------------------------------ helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
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
  let t = store("lc.token");
  if (!t || !/^[\w-]{8,64}$/.test(t)) {
    t = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    store("lc.token", t);
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

// ------------------------------------------------------------------ app state

type Screen = "home" | "lobby" | "game";

const app = {
  screen: "home" as Screen,
  conn: null as Connection | null,
  code: "",
  me: "",
  state: null as GameState | null,
  log: [] as LogEntry[],
  skew: 0,
  /** The round on screen, kept in step by the server's frames. */
  arena: null as Arena | null,
  bannerUntil: 0,
  lastCount: 0,
  swipe: null as { x: number; y: number; dir: Dir | null } | null,
};

const token = playerToken();
const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));
const coarse = window.matchMedia("(pointer: coarse)");

const serverNow = () => Date.now() + app.skew;
const me = (s = app.state): PlayerState | undefined => s?.players.find((p) => p.id === app.me);
const playerById = (id: string | null | undefined) => app.state?.players.find((p) => p.id === id);
const isLive = (s = app.state) => !!s && (s.phase === "countdown" || s.phase === "playing");
const myCycle = (): Cycle | null => {
  const i = app.arena?.index(app.me) ?? -1;
  return i >= 0 ? app.arena!.cycles[i] : null;
};
const canHost = (s = app.state) => {
  if (!s) return false;
  if (s.hostId === app.me) return true;
  const host = s.players.find((p) => p.id === s.hostId);
  return !host || !host.connected;
};

// ------------------------------------------------------------------ routing

function route(): void {
  const m = location.pathname.match(/^\/g\/([A-Za-z0-9]{5})\/?$/);
  const code = m?.[1].toUpperCase();
  if (code && CODE_RE.test(code)) {
    // Coming back to a game you were in (reload, reconnect): straight back in.
    if (store("lc.lastGame") === code && store("lc.name")) void joinGame(code);
    else showHome(code);
  } else {
    showHome(null);
  }
}

function showScreen(screen: Screen): void {
  if (screen !== app.screen) window.scrollTo(0, 0);
  app.screen = screen;
  $("screen-home").hidden = screen !== "home";
  $("screen-lobby").hidden = screen !== "lobby";
  $("screen-game").hidden = screen !== "game";
  if (screen === "game") layoutStage();
  if (screen === "home") attract.resize();
}

function showHome(inviteCode: string | null): void {
  disconnect();
  showScreen("home");
  document.title = "Light Cycles";
  $("home-error").textContent = "";
  const nameInput = $<HTMLInputElement>("home-name");
  nameInput.value = store("lc.name") ?? "";
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
  store("lc.name", name);
  return name;
}

async function createGame(): Promise<void> {
  if (!readName()) return;
  const btn = $<HTMLButtonElement>("home-create");
  btn.disabled = true;
  try {
    const res = await fetch("/api/games", { method: "POST" });
    const body = (await res.json()) as { code?: string; error?: string };
    if (!res.ok || !body.code) throw new Error(body.error ?? "Couldn't create a game");
    history.pushState(null, "", `/g/${body.code}`);
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
  const name = store("lc.name") ?? readName();
  if (!name) return;
  try {
    const res = await fetch(`/api/games/${code}`);
    if (res.status === 404) {
      store("lc.lastGame", null);
      if (location.pathname !== "/") history.replaceState(null, "", "/");
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
  store("lc.lastGame", code);
  if (location.pathname !== `/g/${code}`) history.pushState(null, "", `/g/${code}`);
  app.code = code;
  app.state = null;
  app.log = [];
  app.me = "";
  $("lobby-code").textContent = code;
  $<HTMLInputElement>("lobby-link").value = `${location.origin}/g/${code}`;
  $("game-code-small").textContent = code;
  $("lobby-players").innerHTML = `<li class="muted">Connecting…</li>`;
  showScreen("lobby");

  app.conn = new Connection(code, {
    hello: () => ({ t: "hello", token, name: store("lc.name") ?? name }),
    message: onMessage,
    status: onStatus,
    fatal: (reason) => {
      store("lc.lastGame", null);
      history.pushState(null, "", "/");
      showHome(null);
      $("home-error").textContent = reason;
    },
  });
}

function disconnect(): void {
  app.conn?.close();
  app.conn = null;
  app.state = null;
  app.arena = null;
  $("gameover").hidden = true;
}

function leave(): void {
  const s = app.state;
  if (s && s.phase !== "lobby" && s.phase !== "gameover" && !confirm("Leave this game? Your cycle rides on without you.")) return;
  app.conn?.send({ t: "leave" });
  store("lc.lastGame", null);
  history.pushState(null, "", "/");
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
      setArena(msg.arena);
      applyState(msg.state);
      renderLog();
      break;
    case "state":
      applyState(msg.state);
      break;
    case "arena":
      setArena(msg.arena);
      render();
      break;
    case "frame":
      onFrame(msg.f);
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

function setArena(snap: ArenaSnapshot | null): void {
  app.arena = snap ? new Arena(snap) : null;
  if (app.arena) renderer.reset(app.arena);
}

function applyState(s: GameState): void {
  const prev = app.state;
  app.state = s;
  if (s.phase === "lobby") app.arena = null;
  if (prev && prev.phase !== s.phase) {
    if (s.phase === "playing") {
      sfx.go();
      flashBanner(`<span class="count">GO!</span>`, 700, "count-banner");
    } else if (s.phase === "roundover" && s.roundWinnerId === app.me) {
      sfx.win();
    }
  }
  app.conn?.heartbeat(isLive(s));
  document.title = isLive(s) && myCycle()?.alive ? `▶ Riding — Light Cycles` : `Light Cycles · ${s.code}`;
  render();
}

function onFrame(f: Frame): void {
  const a = app.arena;
  if (!a) return;
  const now = performance.now();
  renderer.beforeFrame(a, now);
  a.apply(f);
  renderer.afterFrame(a, f, now, (id) => playerById(id)?.color ?? "#ffffff", app.me);
  if (!f.e.length) return;
  for (const ev of f.e) {
    if (ev.k === "crash") {
      const mine = a.cycles[ev.i].id === app.me;
      sfx.crash(mine);
      if (mine) flashBanner(`<span class="big">DEREZZED</span>Hang tight for the next round`, 1800);
    } else if (ev.k === "boost") {
      if (a.cycles[ev.i].id === app.me) sfx.boost();
    } else if (ev.k === "shrink" && ev.s === 1) {
      flashBanner(`<span class="big">SUDDEN DEATH</span>The walls are closing in`, 1800);
    }
  }
  if (app.state) renderGame(app.state);
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (app.screen === "home") {
    attract.frame(now);
    return;
  }
  if (app.screen !== "game") return;
  const s = app.state;
  if (app.arena && s) renderer.draw(app.arena, drawOpts(s), now);
  tickClocks();
}

function drawOpts(s: GameState): DrawOpts {
  const riders = new Map<string, RiderInfo>();
  for (const p of s.players) riders.set(p.id, { name: p.name, color: p.color, you: p.id === app.me });
  return { theme: s.theme, riders, labels: s.phase === "countdown", tickMs: tickMsFor(s.settings.speed) };
}

function tickClocks(): void {
  const s = app.state;
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

function formatClock(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ rendering: top level

function render(): void {
  const s = app.state;
  if (!s || app.screen === "home") return;
  if (s.phase === "lobby") {
    if (app.screen !== "lobby") showScreen("lobby");
    renderLobby(s);
  } else {
    if (app.screen !== "game") showScreen("game");
    renderGame(s);
  }
}

// ------------------------------------------------------------------ lobby

const SETTING_LABELS: Record<keyof Settings, { label: string; fmt: (v: never) => string }> = {
  rounds: { label: "Rounds", fmt: (v: number) => String(v) },
  arena: {
    label: "Arena",
    fmt: (v: string) => ({ small: "Small — 80×45", medium: "Medium — 112×63", large: "Large — 144×81" })[v] ?? v,
  },
  speed: { label: "Speed", fmt: (v: string) => ({ chill: "Chill", classic: "Classic", hyper: "Hyper" })[v] ?? v },
  boosts: { label: "Boosts", fmt: (v: number) => (v ? `${v} per round` : "Off") },
  walls: { label: "Walls", fmt: (v: string) => ({ solid: "Solid — crash on contact", wrap: "Wrap-around" })[v] ?? v },
  suddenDeath: { label: "Sudden death", fmt: (v: number) => (v ? `Walls close after ${v}s` : "Off") },
};

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

  $("lobby-cpu").hidden = !host;
  for (const b of $$<HTMLButtonElement>("#lobby-cpu button")) b.disabled = participants.length >= MAX_PLAYERS;

  const mine = me(s);
  const taken = new Set(s.players.filter((p) => p.id !== app.me).map((p) => p.color));
  $("lobby-colors").innerHTML = PLAYER_COLORS.map(
    (c) => `<button class="swatch" style="background:${c}" data-color="${c}" aria-label="Color ${c}"
      aria-pressed="${mine?.color === c}" ${taken.has(c) ? "disabled" : ""}></button>`,
  ).join("");

  const settings = $("lobby-settings");
  settings.innerHTML = (Object.keys(SETTING_LABELS) as (keyof Settings)[])
    .map((key) => {
      const { label, fmt } = SETTING_LABELS[key];
      const value = s.settings[key];
      const control = host
        ? `<select data-setting="${key}">${(SETTING_CHOICES[key] as (string | number)[])
            .map((v) => `<option value="${v}" ${v === value ? "selected" : ""}>${esc((fmt as (v: unknown) => string)(v))}</option>`)
            .join("")}</select>`
        : `<span class="value">${esc((fmt as (v: unknown) => string)(value))}</span>`;
      return `<label class="setting"><span class="label">${label}</span>${control}</label>`;
    })
    .join("");

  const start = $<HTMLButtonElement>("lobby-start");
  start.hidden = !host;
  start.disabled = participants.length < 2;
  const hostName = playerById(s.hostId)?.name ?? "the host";
  $("lobby-wait").textContent = host
    ? participants.length < 2
      ? "Invite a friend or add a CPU to start."
      : ""
    : `Waiting for ${hostName} to start the game…`;
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
  const s = app.state;
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
        p.id === app.me ? "you" : "",
        s.phase === "roundover" && s.roundWinnerId === p.id ? "winner" : "",
        (live && cyc && !cyc.alive) || (!cyc && live) ? "out" : "",
        !p.cpu && !p.connected ? "offline" : "",
      ].join(" ");
      const tag = p.id === app.me ? ` <span class="tag tag-you">you</span>` : p.cpu ? ` <span class="tag">CPU</span>` : "";
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
  const s = app.state;
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

// ------------------------------------------------------------------ steering

function steer(dir: Dir): void {
  const cyc = myCycle();
  if (!isLive() || !cyc?.alive) return;
  unlockAudio();
  if (app.conn?.send({ t: "turn", dir }) && dir !== cyc.dir && dir !== (cyc.dir + 2) % 4) sfx.turn();
}

function boost(): void {
  const cyc = myCycle();
  if (app.state?.phase !== "playing" || !cyc?.alive || cyc.boosts <= 0 || cyc.boost > 0) return;
  unlockAudio();
  app.conn?.send({ t: "boost" });
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
  window.addEventListener("popstate", route);
  window.addEventListener("resize", () => (app.screen === "home" ? attract.resize() : layoutStage()));
  new ResizeObserver(() => app.screen === "game" && renderer.resize($("stage").clientWidth)).observe($("stage"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") app.conn?.nudge();
  });
  for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, unlockAudio, { passive: true });

  // Home
  $("home-name").addEventListener("change", (e) => store("lc.name", (e.target as HTMLInputElement).value.trim()));
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
    history.pushState(null, "", "/");
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
      // Hand the keyboard back to the grid.
      if (isLive()) input.blur();
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
      toast("Press Ctrl/⌘+C to copy", "info");
    }
  });
  $("lobby-link").addEventListener("focus", (e) => (e.target as HTMLInputElement).select());
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
    const value = typeof SETTING_CHOICES[key][0] === "number" ? Number(el.value) : el.value;
    app.conn?.send({ t: "settings", settings: { [key]: value } });
  });
  $("lobby-start").addEventListener("click", () => app.conn?.send({ t: "start" }));

  // Steering: keyboard, the on-screen pad, and swipes on the grid.
  window.addEventListener("keydown", (e) => {
    if (app.screen !== "game" || !isLive()) return;
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

  // Game over
  $("gameover-lobby").addEventListener("click", () => app.conn?.send({ t: "lobby" }));

  const mute = $("mute");
  const paintMute = () => {
    mute.textContent = isMuted() ? "🔇" : "🔊";
    mute.setAttribute("aria-pressed", String(isMuted()));
  };
  paintMute();
  mute.addEventListener("click", () => {
    setMuted(!isMuted());
    paintMute();
    mute.blur(); // so Space boosts instead of toggling sound
  });
}

wire();
route();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __lc: { app, renderer } });
