import type { BottleEvent } from "../shared/bottle";
import { CODE_RE, COLS, MAX_PLAYERS, PLAYER_COLORS, TICKS_PER_SEC, TICK_MS, virusCount } from "../shared/constants";
import {
  SETTING_CHOICES,
  type Aim,
  type Attack,
  type GameState,
  type LogEntry,
  type PlayerState,
  type RoundSnap,
  type ServerMsg,
  type Settings,
  type Speed,
} from "../shared/protocol";
import { Attract } from "./attract";
import { isMuted, setMuted, sfx, unlockAudio } from "./audio";
import { Controls } from "./input";
import { Connection, type NetStatus } from "./net";
import { BottleCanvas, bottleSize } from "./render";
import { RoundView } from "./view";

// ------------------------------------------------------------------ helpers

// The app lives under Vite's `base` ("/pill-panic/"): BASE is the home screen, gamePath() a game.
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
  let t = store("pp.token");
  if (!t || !/^[\w-]{8,64}$/.test(t)) {
    t = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    store("pp.token", t);
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

function pips(wins: number, target: number): string {
  const n = Math.max(target, wins);
  return Array.from({ length: n }, (_, i) => `<i class="${i < wins ? "on" : ""}"></i>`).join("");
}

const SPEED_NAMES: Record<Speed, string> = { low: "Low", med: "Med", hi: "Hi" };
const PALETTE = ["#fff", "#ff4d6d", "#ffd23f", "#4da6ff"];

// ------------------------------------------------------------------ app state

type Screen = "home" | "lobby" | "game";

interface RivalCard {
  slot: number;
  el: HTMLElement;
  canvas: BottleCanvas;
}

const app = {
  screen: "home" as Screen,
  conn: null as Connection | null,
  code: "",
  me: "",
  state: null as GameState | null,
  log: [] as LogEntry[],
  /** Server clock minus ours, from the quickest ping. */
  skew: 0,
  pings: [] as { rtt: number; skew: number }[],
  pingTimer: 0,
  /** This browser's copy of the round. */
  view: null as RoundView | null,
  viewKey: "",
  /** Names and colors of everyone seen, so a player who left still has a label. */
  people: new Map<string, { name: string; color: string }>(),
  rivals: new Map<number, RivalCard>(),
  rivalKey: "",
  layoutKey: "",
  ownCell: 0,
  lastFrame: 0,
  bannerKey: "",
  sounded: "",
  overSounded: "",
};

const token = playerToken();
const ownCanvas = new BottleCanvas($<HTMLCanvasElement>("game-canvas"), true);
const attract = new Attract($<HTMLCanvasElement>("attract"));

const me = (s = app.state): PlayerState | undefined => s?.players.find((p) => p.id === app.me);
const playerById = (id: string | null | undefined) => app.state?.players.find((p) => p.id === id);
const canHost = (s = app.state) => {
  if (!s) return false;
  if (s.hostId === app.me) return true;
  const host = s.players.find((p) => p.id === s.hostId);
  return !host || !host.connected;
};
const serverNow = () => Date.now() + app.skew;
const wallTick = () => app.view?.wall(serverNow()) ?? -1;
const colorOf = (slot: number) => app.people.get(app.view?.who[slot] ?? "")?.color ?? "#8d94b8";

const controls = new Controls(() => {
  const v = app.view;
  const own = v?.own;
  return app.screen === "game" && !!own && !v.over && !own.b.done && wallTick() >= 0;
});
controls.bindPad($("pad"));

// ------------------------------------------------------------------ routing

function route(): void {
  const m = location.pathname.slice(BASE.length).match(/^g\/([A-Za-z0-9]{5})\/?$/);
  const code = m?.[1].toUpperCase();
  if (code && CODE_RE.test(code)) {
    // Coming back to a game you were in (reload, reconnect): straight back in.
    if (store("pp.lastGame") === code && store("pp.name")) void joinGame(code);
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
  if (screen === "game") layout();
  if (screen === "home") attract.resize();
}

function showHome(inviteCode: string | null): void {
  disconnect();
  showScreen("home");
  document.title = "Pill Panic";
  $("home-error").textContent = "";
  const nameInput = $<HTMLInputElement>("home-name");
  nameInput.value = store("pp.name") ?? "";
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
  store("pp.name", name);
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
  const name = store("pp.name") ?? readName();
  if (!name) return;
  try {
    const res = await fetch(`${BASE}api/games/${code}`);
    if (res.status === 404) {
      store("pp.lastGame", null);
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
  store("pp.lastGame", code);
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
    hello: () => ({ t: "hello", token, name: store("pp.name") ?? name }),
    message: onMessage,
    status: onStatus,
    fatal: (reason) => {
      store("pp.lastGame", null);
      history.pushState(null, "", BASE);
      showHome(null);
      $("home-error").textContent = reason;
    },
  });
  clearInterval(app.pingTimer);
  app.pingTimer = window.setInterval(ping, 2000);
}

function disconnect(): void {
  app.conn?.close();
  app.conn = null;
  app.state = null;
  app.view = null;
  app.viewKey = "";
  app.pings = [];
  clearInterval(app.pingTimer);
  controls.reset();
  $("results").hidden = true;
}

function leave(): void {
  const s = app.state;
  const inRound = s?.phase === "playing" && (me()?.slot ?? -1) >= 0 && !s.round?.over;
  if (inRound && !confirm("Leave this game? Your bottle tops out.")) return;
  app.conn?.send({ t: "leave" });
  store("pp.lastGame", null);
  history.pushState(null, "", BASE);
  showHome(null);
}

function onStatus(status: NetStatus): void {
  for (const el of [$("lobby-conn"), $("game-conn")]) {
    el.dataset.status = status;
    el.textContent = status === "open" ? "" : status === "connecting" ? "Connecting…" : "Reconnecting…";
  }
  if (status === "open") ping();
}

/** Measure the server's clock: every bottle runs on it. */
function ping(): void {
  app.conn?.send({ t: "ping", c: Date.now() });
}

// ------------------------------------------------------------------ messages

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case "welcome":
      if (!app.pings.length) app.skew = msg.now - Date.now();
      app.me = msg.you;
      app.log = msg.log;
      applyState(msg.state);
      setView(msg.snap);
      renderLog();
      break;
    case "state":
      if (!app.pings.length) app.skew = msg.now - Date.now();
      applyState(msg.state);
      break;
    case "snap":
      setView(msg.snap);
      break;
    case "f":
      if (!app.view) return;
      app.view.frame(msg);
      // Keep our bottle going (and reporting) even when the tab is in the background.
      app.view.stepOwn(wallTick(), () => controls.sample());
      break;
    case "pong": {
      if (typeof msg.c !== "number") break;
      const rtt = Date.now() - msg.c;
      app.pings.push({ rtt, skew: msg.now + rtt / 2 - Date.now() });
      if (app.pings.length > 10) app.pings.shift();
      app.skew = app.pings.reduce((a, b) => (b.rtt < a.rtt ? b : a)).skew;
      break;
    }
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

function setView(snap: RoundSnap | null): void {
  if (!snap) return;
  const key = `${snap.round}:${snap.lanes[0]?.b.seed ?? 0}`;
  if (app.view && app.viewKey === key) {
    app.view.applySnap(snap);
  } else {
    app.view = new RoundView(snap, app.me, {
      send: (m) => !!app.conn?.send(m),
      events: onBottleEvents,
      attack: onAttack,
    });
    app.viewKey = key;
    app.bannerKey = "";
    controls.reset();
  }
  app.view.syncState(app.state?.round);
  layout();
}

function applyState(s: GameState): void {
  const prev = app.state;
  app.state = s;
  for (const p of s.players) app.people.set(p.id, { name: p.name, color: p.color });
  if (s.phase === "lobby") {
    app.view = null;
    app.viewKey = "";
  }
  app.view?.syncState(s.round);
  const over = s.round?.over;
  if (over && s.round) {
    const key = `${s.match}:${s.round.n}`;
    if (app.overSounded !== key && prev) {
      app.overSounded = key;
      if (over.winners.includes(app.me)) sfx.win();
      else if (app.view?.mine !== undefined && app.view.mine >= 0) sfx.lose();
    }
  }
  document.title = s.phase === "playing" ? `Pill Panic · ${s.code}` : `Pill Panic · ${s.code} · ${s.phase}`;
  render();
}

// ------------------------------------------------------------------ effects

function onBottleEvents(slot: number, events: BottleEvent[]): void {
  const mine = slot === app.view?.mine;
  for (const e of events) {
    if (!mine) {
      if (e.k === "pop" && e.chain >= 2) popup(rivalEl(slot), `${e.chain} CHAIN`);
      continue;
    }
    switch (e.k) {
      case "move":
        sfx.move();
        break;
      case "rotate":
        sfx.rotate();
        break;
      case "land":
        sfx.land();
        break;
      case "pop":
        sfx.pop(e.chain, e.viruses);
        if (e.chain >= 2) popup($("stage"), `${e.chain} CHAIN!`);
        break;
      case "attack":
        popup($("stage"), `ATTACK ×${e.colors.length}`);
        break;
      case "garbage":
        sfx.garbage();
        break;
      case "won":
        sfx.clear();
        break;
      case "dead":
        sfx.out();
        break;
    }
  }
}

function onAttack(a: Attack): void {
  const mine = app.view?.mine ?? -1;
  if (a.from === mine) sfx.attack();
  if (a.to === mine) sfx.warn();
  const from = a.from === mine ? $("stage") : rivalEl(a.from);
  const to = a.to === mine ? $("stage") : rivalEl(a.to);
  if (!from || !to || app.screen !== "game") return;
  const r1 = from.getBoundingClientRect();
  const r2 = to.getBoundingClientRect();
  a.p.forEach(([, c], i) => {
    const dot = document.createElement("div");
    dot.className = "flyer";
    dot.style.color = PALETTE[c];
    dot.style.left = `${r1.left + r1.width / 2}px`;
    dot.style.top = `${r1.top + r1.height * 0.4}px`;
    document.body.append(dot);
    const dx = r2.left + r2.width / 2 - (r1.left + r1.width / 2) + (i - a.p.length / 2) * 12;
    const dy = r2.top + r2.height * 0.15 - (r1.top + r1.height * 0.4);
    const anim = dot.animate(
      [
        { transform: "translate(0, 0) scale(1)" },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 60}px) scale(1.3)`, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.7)` },
      ],
      { duration: 550 + i * 60, easing: "ease-in-out" },
    );
    anim.onfinish = () => {
      dot.remove();
      if (i === 0 && to !== $("stage")) {
        to.classList.remove("hit");
        void to.offsetWidth;
        to.classList.add("hit");
      }
    };
  });
}

function popup(host: HTMLElement | null, text: string): void {
  if (!host) return;
  const el = document.createElement("div");
  el.className = "chain-pop";
  el.textContent = text;
  el.style.top = `${host.clientHeight * 0.3}px`;
  host.append(el);
  el.addEventListener("animationend", () => el.remove());
}

function rivalEl(slot: number): HTMLElement | null {
  return app.rivals.get(slot)?.el ?? null;
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = app.lastFrame ? now - app.lastFrame : 16;
  app.lastFrame = now;
  if (app.screen === "home") {
    attract.frame(now);
    return;
  }
  const v = app.view;
  if (app.screen !== "game" || !v) return;
  v.stepOwn(wallTick(), () => controls.sample());
  v.advanceMirrors(Math.min(30, dt / TICK_MS));
  if (v.own) {
    ownCanvas.draw(v.own.b, {
      time: now,
      ghost: true,
      next: true,
      incoming: v.incoming(v.mine),
      accent: colorOf(v.mine),
      dim: v.own.b.phase === "dead",
    });
  }
  for (const card of app.rivals.values()) {
    const b = v.bottle(card.slot);
    if (!b) continue;
    card.canvas.draw(b, {
      time: now,
      ghost: false,
      next: false,
      incoming: v.incoming(card.slot),
      accent: colorOf(card.slot),
      dim: b.phase === "dead",
    });
  }
  renderBanner();
  renderLive();
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

const AIM_NAMES: Record<Aim, string> = {
  leader: "Whoever's winning",
  random: "A random rival",
  all: "Everyone",
};

const SETTING_LABELS: Record<keyof Settings, { label: string; fmt: (v: never) => string }> = {
  level: { label: "Germ level", fmt: (v: number) => `${v} · ${virusCount(v)} germs` },
  speed: { label: "Speed", fmt: (v: Speed) => ({ low: "Low", med: "Medium", hi: "High" })[v] },
  wins: { label: "Match", fmt: (v: number) => `First to ${v} round${v === 1 ? "" : "s"}` },
  aim: { label: "Junk hits", fmt: (v: Aim) => AIM_NAMES[v] },
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
        p.trophies ? `<span class="tag">${p.trophies} match${p.trophies > 1 ? "es" : ""} won</span>` : "",
        !p.cpu && !p.connected ? `<span class="tag">offline</span>` : "",
      ].join("");
      const kick =
        host && p.id !== app.me
          ? `<button class="kick" data-kick="${p.id}" title="Remove ${esc(p.name)}" aria-label="Remove ${esc(p.name)}">×</button>`
          : "";
      return `<li class="${!p.cpu && !p.connected ? "offline" : ""}">
        <span class="chip" style="background:${p.color}"></span>
        <span class="pname">${esc(p.name)}</span>${tags}<span class="spacer"></span>${kick}</li>`;
    })
    .join("");

  $("lobby-cpu").hidden = !host;
  for (const b of $$<HTMLButtonElement>("#lobby-cpu button")) {
    b.disabled = participants.length >= MAX_PLAYERS;
    b.title = b.disabled ? `The game is full (${MAX_PLAYERS} players)` : "";
  }

  const mine = me(s);
  const taken = new Map(s.players.filter((p) => p.id !== app.me).map((p) => [p.color, p.name]));
  $("lobby-colors").innerHTML = PLAYER_COLORS.map(
    (c) => `<button class="swatch" style="background:${c}" data-color="${c}"
      aria-label="${taken.has(c) ? `Color taken by ${esc(taken.get(c)!)}` : `Color ${c}`}"
      title="${taken.has(c) ? `Taken by ${esc(taken.get(c)!)}` : ""}"
      aria-pressed="${mine?.color === c}" ${taken.has(c) ? "disabled" : ""}></button>`,
  ).join("");

  $("lobby-settings").innerHTML = (Object.keys(SETTING_LABELS) as (keyof Settings)[])
    .map((key) => {
      const { label, fmt } = SETTING_LABELS[key];
      const value = s.settings[key];
      const show = fmt as (v: unknown) => string;
      const control = host
        ? `<select data-setting="${key}">${(SETTING_CHOICES[key] as (string | number)[])
            .map((v) => `<option value="${v}" ${v === value ? "selected" : ""}>${esc(show(v))}</option>`)
            .join("")}</select>`
        : `<span class="value">${esc(show(value))}</span>`;
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
  const r = s.round;
  $("round-label").textContent = r ? `Match ${s.match} · Round ${r.n} · first to ${s.settings.wins}` : "";
  $("match-label").textContent = `First to ${s.settings.wins}`;
  const mine = me(s);
  $("own-chip").style.background = mine?.color ?? "#888";
  $("own-name").textContent = mine?.name ?? "";
  $("own-pips").innerHTML = mine ? pips(mine.wins, s.settings.wins) : "";
  $("hud-level").textContent = r ? String(r.level) : "—";
  $("hud-speed").textContent = r ? SPEED_NAMES[r.speed] : "—";
  syncRivals();
  renderResults(s);
}

/** Cards for everyone else's bottle; rebuilt when who's playing changes. */
function syncRivals(): void {
  const v = app.view;
  const slots = v ? v.slots().filter((s) => s !== v.mine) : [];
  const key = `${app.viewKey}|${slots.join(",")}`;
  const watching = !v?.own;
  document.querySelector(".game-layout")!.classList.toggle("watching", watching);
  if (key !== app.rivalKey) {
    app.rivalKey = key;
    const box = $("rivals");
    box.innerHTML = "";
    app.rivals.clear();
    for (const slot of slots) {
      const el = document.createElement("div");
      el.className = "rival";
      el.innerHTML = `<div class="rival-head"><span class="chip"></span><span class="pname"></span><span class="pips"></span></div>
        <canvas></canvas><div class="rival-foot"><span>Germs <b class="germs"></b></span><span class="junk"></span></div>
        <div class="status"></div>`;
      box.append(el);
      app.rivals.set(slot, { slot, el, canvas: new BottleCanvas(el.querySelector("canvas")!, false) });
    }
  }
  const s = app.state;
  for (const card of app.rivals.values()) {
    const id = v?.who[card.slot];
    const p = s?.players.find((x) => x.id === id);
    const look = app.people.get(id ?? "");
    card.el.querySelector<HTMLElement>(".chip")!.style.background = look?.color ?? "#888";
    card.el.querySelector(".pname")!.textContent = look?.name ?? "Someone";
    card.el.querySelector(".pips")!.innerHTML = p && s ? pips(p.wins, s.settings.wins) : "";
  }
  const note = $("watch-note");
  const mine = me();
  note.hidden = !watching || !s || s.phase !== "playing";
  note.textContent = mine?.spectator
    ? `All ${MAX_PLAYERS} seats are taken, so you're watching. You'll get a seat when one frees up between rounds.`
    : "You're watching this round. You'll play from the next one.";
  const shape = `${key}|${watching}|${note.hidden}`;
  if (shape !== app.layoutKey) {
    app.layoutKey = shape;
    layout();
  }
}

/** The parts that change every frame: germ counts, statuses. Cheap DOM writes only when they change. */
let liveKey = "";
function renderLive(): void {
  const v = app.view;
  const s = app.state;
  if (!v || !s) return;
  const own = v.own?.b;
  const germs = own ? String(own.viruses) : "—";
  let key = germs;
  for (const card of app.rivals.values()) {
    const b = v.bottle(card.slot);
    if (!b) continue;
    const id = v.who[card.slot];
    const gone = !!id && !s.players.some((p) => p.id === id);
    const status = b.phase === "won" ? "CLEAR!" : b.phase === "dead" ? (gone ? "LEFT" : "OUT") : "";
    const junk = v.incoming(card.slot).reduce((n, g) => n + g.p.length, 0);
    key += `|${card.slot}:${b.viruses}:${status}:${junk}`;
  }
  const over = s.round?.over;
  key += `|${over ? over.winners.join() : ""}`;
  if (key === liveKey) return;
  liveKey = key;
  $("hud-germs").textContent = germs;
  for (const card of app.rivals.values()) {
    const b = v.bottle(card.slot);
    if (!b) continue;
    const id = v.who[card.slot];
    const gone = !!id && !s.players.some((p) => p.id === id);
    card.el.querySelector(".germs")!.textContent = String(b.viruses);
    const junk = v.incoming(card.slot).reduce((n, g) => n + g.p.length, 0);
    card.el.querySelector(".junk")!.textContent = junk ? `+${junk} junk` : "";
    const winner = !!over && !!id && over.winners.includes(id);
    const status = winner ? "WINS!" : b.phase === "won" ? "CLEAR!" : b.phase === "dead" ? (gone ? "LEFT" : "OUT") : "";
    card.el.querySelector(".status")!.textContent = status;
    card.el.classList.toggle("out", b.phase === "dead");
  }
  renderScoreboard();
}

function renderScoreboard(): void {
  const s = app.state;
  const v = app.view;
  if (!s) return;
  const rows = s.players
    .filter((p) => !p.spectator)
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name))
    .map((p) => {
      const b = v && p.slot >= 0 && v.who[p.slot] === p.id ? v.bottle(p.slot) : null;
      const status = !b
        ? s.phase === "playing"
          ? !p.cpu && !p.connected
            ? "offline"
            : "sitting this round out"
          : ""
        : b.phase === "won"
          ? "cleared the bottle"
          : b.phase === "dead"
            ? "topped out"
            : `${b.viruses} germ${b.viruses === 1 ? "" : "s"} left`;
      return `<li class="${p.id === app.me ? "me" : ""} ${b?.phase === "dead" ? "out" : ""}">
        <span class="chip" style="background:${p.color}"></span>
        <span class="pname">${esc(p.name)}${p.id === app.me ? ` <span class="tag tag-you">you</span>` : ""}</span>
        <span class="pips">${pips(p.wins, s.settings.wins)}</span>
        <span class="meta">${status}${p.sent ? ` · ${p.sent} junk sent` : ""}</span>
      </li>`;
    })
    .join("");
  const el = $("scoreboard");
  if (el.innerHTML !== rows) el.innerHTML = rows;
}

/** The big message over your bottle: countdown, GO, cleared, topped out, who took the round. */
function renderBanner(): void {
  const v = app.view;
  const s = app.state;
  let big = "";
  let sub = "";
  let sound = "";
  const r = s?.round;
  if (v && s && r && s.phase === "playing") {
    const wall = wallTick();
    const own = v.own?.b;
    if (r.over) {
      const winners = r.over.winners;
      if (!winners.length) big = "DRAW!";
      else if (winners.includes(app.me)) big = "YOU WIN!";
      else big = `${(app.people.get(winners[0])?.name ?? "?").toUpperCase()} WINS`;
      const how =
        r.over.how === "cleared" ? "cleared the bottle first" : r.over.how === "survived" ? "was the last one standing" : "";
      const who = winners.includes(app.me) ? "You" : winners.map((id) => esc(app.people.get(id)?.name ?? "?")).join(" & ");
      const next = r.nextAt ? Math.max(0, Math.ceil((r.nextAt - serverNow()) / 1000)) : 0;
      sub = `${how ? `${who} ${how}. ` : ""}${r.nextAt ? `Next round in ${next}…` : ""}`;
    } else if (wall < 0) {
      const n = Math.ceil(-wall / TICKS_PER_SEC);
      big = String(n);
      sub = own ? `Level ${r.level} · ${virusCount(r.level)} germs · clear them all first` : "";
      sound = `count${r.n}:${n}`;
    } else if (wall < TICKS_PER_SEC * 0.8 && own) {
      big = "GO!";
      sound = `go${r.n}`;
    } else if (own?.phase === "won") {
      big = "CLEAR!";
      sub = "Checking nobody beat you to it…";
    } else if (own?.phase === "dead") {
      big = "TOPPED OUT";
      sub = "You're out of this round. Watch the others.";
    }
  }
  if (sound && sound !== app.sounded) {
    app.sounded = sound;
    if (sound.startsWith("go")) sfx.go();
    else sfx.count();
  }
  const key = `${big}|${sub}`;
  if (key === app.bannerKey) return;
  app.bannerKey = key;
  const el = $("banner");
  el.hidden = !big;
  el.innerHTML = big ? `<div class="big">${esc(big)}</div>${sub ? `<div class="sub">${sub}</div>` : ""}` : "";
}

function renderResults(s: GameState): void {
  const r = s.results;
  const open = s.phase === "results" && !!r;
  $("results").hidden = !open;
  if (!open || !r) return;
  $("results-title").textContent = `Match ${r.match} results`;
  const winner = r.standings.find((x) => x.id === r.winnerId);
  $("results-winner").innerHTML = winner
    ? `<b style="color:${winner.color}">${esc(winner.id === app.me ? "You" : winner.name)}</b> ${winner.id === app.me ? "win" : "wins"} the match, ${winner.wins} round${winner.wins === 1 ? "" : "s"} to ${Math.max(0, ...r.standings.filter((x) => x !== winner).map((x) => x.wins))}.`
    : esc(r.note || "No winner this time.");
  $("results-rows").innerHTML = r.standings
    .map((x, i) => {
      const p = playerById(x.id);
      return `<tr class="${x.id === r.winnerId ? "winner" : ""}">
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${x.color}"></span>${esc(x.name)}${x.id === app.me ? ` <span class="tag tag-you">you</span>` : ""}</span></td>
        <td>${x.wins}</td><td>${x.cleared}</td><td>${x.sent}</td><td>${p?.trophies ?? "—"}</td></tr>`;
    })
    .join("");
  const host = canHost(s);
  const again = $<HTMLButtonElement>("results-again");
  const lobby = $<HTMLButtonElement>("results-lobby");
  again.hidden = lobby.hidden = !host;
  const enough = s.players.filter((p) => !p.spectator && (p.cpu || p.connected)).length >= 2;
  again.disabled = !enough;
  $("results-wait").textContent = host
    ? enough
      ? ""
      : "Need at least two players for another match — add a CPU from the lobby."
    : `Waiting for ${playerById(s.hostId)?.name ?? "the host"} to start the next match…`;
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

/** Size everyone else's bottles to the space beside yours (above it on phones), then yours to what's left. */
function layout(): void {
  if (app.screen !== "game") return;
  const narrow = window.innerWidth <= 760;
  const v = app.view;
  const rivals = app.rivals.size;

  if (rivals) {
    const rc = rivalCell(rivals, narrow, !v?.own);
    for (const card of app.rivals.values()) {
      if (card.canvas.cell !== rc) card.canvas.resize(rc);
    }
  }

  // Your bottle: as tall as the window allows above its stats and (on touch screens) the pad.
  const padShown = getComputedStyle($("pad")).display !== "none";
  const top = $("own-col").getBoundingClientRect().top + window.scrollY;
  const below = 24 + 50 + (padShown ? 120 : 30) + 40;
  let cell = Math.floor((window.innerHeight - top - below) / 19.4);
  cell = Math.min(cell, Math.floor((window.innerWidth - (narrow ? 24 : 340)) / (COLS + 1.4)));
  cell = Math.max(12, Math.min(34, cell));
  if (cell !== app.ownCell) {
    app.ownCell = cell;
    ownCanvas.resize(cell);
  }
  const width = narrow ? "none" : `${Math.max(260, bottleSize(cell, true).w)}px`;
  for (const el of [$("own-col").querySelector<HTMLElement>(".own-head")!, $("own-col").querySelector<HTMLElement>(".own-stats")!, $("pad")]) {
    el.style.maxWidth = width;
  }
}

/** The biggest cell size at which every rival's bottle fits. On phones they share one short strip. */
function rivalCell(n: number, narrow: boolean, watching = false): number {
  if (narrow) {
    const w = window.innerWidth - 16;
    const most = watching ? 12 : Math.max(4, Math.min(7, Math.floor((window.innerHeight * 0.2 - 44) / 18.3)));
    for (let c = most; c > 4; c--) if (n * (bottleSize(c, false).w + 14) <= w) return c;
    return 4;
  }
  const box = document.querySelector<HTMLElement>(".rivals-col")!;
  const width = Math.max(200, box.clientWidth);
  const height = Math.max(240, window.innerHeight - box.getBoundingClientRect().top - window.scrollY - 24);
  for (let c = watching ? 30 : 24; c > 5; c--) {
    const { w, h } = bottleSize(c, false);
    const perRow = Math.max(1, Math.floor((width + 12) / (w + 12 + 16)));
    const rows = Math.ceil(n / perRow);
    if (rows * (h + 60) <= height) return c;
  }
  return 6;
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  window.addEventListener("popstate", route);
  window.addEventListener("resize", () => (app.screen === "home" ? attract.resize() : layout()));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") app.conn?.nudge();
  });
  for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, unlockAudio, { passive: true });

  // Home
  $("home-name").addEventListener("change", (e) => store("pp.name", (e.target as HTMLInputElement).value.trim()));
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
      // Hand the keyboard back to the bottle after chatting mid-round.
      if (app.screen === "game") input.blur();
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
    const value = key === "level" || key === "wins" ? Number(el.value) : el.value;
    app.conn?.send({ t: "settings", settings: { [key]: value } });
  });
  $("lobby-start").addEventListener("click", () => app.conn?.send({ t: "start" }));

  // Results
  $("results-again").addEventListener("click", () => app.conn?.send({ t: "start" }));
  $("results-lobby").addEventListener("click", () => app.conn?.send({ t: "lobby" }));

  const mute = $("mute");
  const paintMute = () => {
    mute.textContent = isMuted() ? "🔇" : "🔊";
    mute.setAttribute("aria-pressed", String(isMuted()));
  };
  paintMute();
  mute.addEventListener("click", () => {
    setMuted(!isMuted());
    paintMute();
    mute.blur();
  });
}

wire();
route();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __pp: { app, controls } });
