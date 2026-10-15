import type { DeathCause, Dir, Frame, Op } from "../shared/board";
import { forEachRunCell } from "../shared/codec";
import { CODE_RE, MAX_PLAYERS, PLAYER_COLORS, TICKS_PER_SEC } from "../shared/constants";
import {
  BOARD_SIZES,
  SETTING_CHOICES,
  percent,
  type BoardSize,
  type GameState,
  type LogEntry,
  type PlayerState,
  type ServerMsg,
  type Settings,
  type Snapshot,
} from "../shared/protocol";
import { applyFrame, viewFromSnapshot, type RoundView } from "../shared/sim";
import { Attract } from "./attract";
import { isMuted, setMuted, sfx, unlockAudio } from "./audio";
import { Controls } from "./input";
import { Connection, type NetStatus } from "./net";
import { Renderer, type Look, type Scene } from "./render";

// ------------------------------------------------------------------ helpers

// The app lives under Vite's `base` ("/turf-war/"): BASE is the home screen, gamePath() a game.
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
  let t = store("tw.token");
  if (!t || !/^[\w-]{8,64}$/.test(t)) {
    t = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    store("tw.token", t);
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

function clock(ticks: number): string {
  const secs = Math.max(0, Math.ceil(ticks / TICKS_PER_SEC));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ app state

type Screen = "home" | "lobby" | "game";

interface FeedItem {
  html: string;
  at: number;
}

const app = {
  screen: "home" as Screen,
  conn: null as Connection | null,
  code: "",
  me: "",
  state: null as GameState | null,
  log: [] as LogEntry[],
  skew: 0,
  /** Our copy of the round, kept in step by the server's frames. */
  view: null as RoundView | null,
  /** Board slot → how it looks. Kept from the last state seen in play, so the final board keeps its colors. */
  looks: Array<Look | null>(MAX_PLAYERS).fill(null),
  mySlot: -1,
  /** The tick last painted into the renderer, and the palette it used. */
  painted: -1,
  paintKey: "",
  resyncing: false,
  feed: [] as FeedItem[],
  /** Why we last died, for the respawn banner. */
  death: null as { by: number; why: DeathCause } | null,
  bannerKey: "",
  sounded: "",
  stageWidth: 0,
};

const token = playerToken();
const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));

const me = (s = app.state): PlayerState | undefined => s?.players.find((p) => p.id === app.me);
const playerById = (id: string | null | undefined) => app.state?.players.find((p) => p.id === id);
const canHost = (s = app.state) => {
  if (!s) return false;
  if (s.hostId === app.me) return true;
  const host = s.players.find((p) => p.id === s.hostId);
  return !host || !host.connected;
};
const myHead = () => (app.view && app.mySlot >= 0 ? app.view.board.heads[app.mySlot] : null);
const inPlay = () => {
  const v = app.view;
  return app.state?.phase === "playing" && !!v && v.n < v.end;
};

const controls = new Controls($("stage"), {
  active: () => app.screen === "game" && inPlay() && !!myHead()?.alive,
  head: () => {
    const h = myHead();
    return h ? { dir: h.dir, fresh: h.fresh } : null;
  },
  send: (d: Dir) => app.conn?.send({ t: "dir", d }),
});

// ------------------------------------------------------------------ routing

function route(): void {
  const m = location.pathname.slice(BASE.length).match(/^g\/([A-Za-z0-9]{5})\/?$/);
  const code = m?.[1].toUpperCase();
  if (code && CODE_RE.test(code)) {
    // Coming back to a game you were in (reload, reconnect): straight back in.
    if (store("tw.lastGame") === code && store("tw.name")) void joinGame(code);
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
  if (screen === "game") layoutStage();
  if (screen === "home") attract.resize();
}

function showHome(inviteCode: string | null): void {
  disconnect();
  showScreen("home");
  document.title = "Turf War";
  $("home-error").textContent = "";
  const nameInput = $<HTMLInputElement>("home-name");
  nameInput.value = store("tw.name") ?? "";
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
  store("tw.name", name);
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
  const name = store("tw.name") ?? readName();
  if (!name) return;
  try {
    const res = await fetch(`${BASE}api/games/${code}`);
    if (res.status === 404) {
      store("tw.lastGame", null);
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
  store("tw.lastGame", code);
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
    hello: () => ({ t: "hello", token, name: store("tw.name") ?? name }),
    message: onMessage,
    status: onStatus,
    fatal: (reason) => {
      store("tw.lastGame", null);
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
  app.view = null;
  app.mySlot = -1;
  app.feed = [];
  app.death = null;
  $("results").hidden = true;
}

function leave(): void {
  const s = app.state;
  if (s?.phase === "playing" && (me()?.slot ?? -1) >= 0 && !confirm("Leave this game? Your land disappears.")) return;
  app.conn?.send({ t: "leave" });
  store("tw.lastGame", null);
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
      setView(msg.snap);
      applyState(msg.state);
      renderLog();
      break;
    case "state":
      applyState(msg.state);
      break;
    case "snap":
      setView(msg.snap);
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

function setView(snap: Snapshot | null): void {
  app.resyncing = false;
  if (!snap) return;
  const v = viewFromSnapshot(snap);
  if (!v) return;
  const resized = !app.view || app.view.board.w !== v.board.w || app.view.board.h !== v.board.h;
  if (v.n === 0 || (app.view && v.n < app.view.n)) {
    // A new round.
    app.feed = [];
    app.death = null;
  }
  app.view = v;
  app.painted = -1;
  controls.reset();
  if (resized) layoutStage();
  renderHud();
}

function requestResync(): void {
  if (app.resyncing) return;
  app.resyncing = !!app.conn?.send({ t: "resync" });
}

function onFrame(f: Frame): void {
  const v = app.view;
  if (!v) return requestResync();
  if (f.n <= v.n) return; // already have it
  if (!applyFrame(v, f)) return requestResync();
  if (f.ck !== undefined && v.board.checksum() !== f.ck) {
    console.warn(`Board drifted from the server at tick ${f.n}; resyncing`);
    requestResync();
  }
  for (const op of f.o) onOp(op);
  renderHud();
  renderScoreboard();
}

/** Sounds, the kill feed and the respawn banner, from what happened this tick. */
function onOp(op: Op): void {
  const mine = app.mySlot;
  switch (op[0]) {
    case "m":
      if (mine >= 0 && ((op[mine + 1] as number | undefined) ?? -1) >= 0) controls.ticked();
      return;
    case "c": {
      if (op[1] !== mine) return;
      let n = 0;
      forEachRunCell(op as number[], 2, () => n++);
      sfx.claim(n);
      return;
    }
    case "d": {
      const [, slot, by, , why] = op;
      if (why === "left") return;
      if (slot === mine) {
        app.death = { by, why };
        controls.reset();
        sfx.die();
      } else if (by === mine && (why === "trail" || why === "squeeze")) {
        sfx.kill();
      } else {
        sfx.thud();
      }
      // A head-on comes as one death each; report it once.
      if (why === "headon" && by >= 0 && by < slot) return;
      const text = feedText(slot, by, why);
      if (text) {
        app.feed.push({ html: text, at: performance.now() });
        if (app.feed.length > 5) app.feed.shift();
        renderFeed();
      }
      return;
    }
    case "s":
      if (op[1] === mine) {
        app.death = null;
        controls.reset();
        sfx.spawn();
      }
      return;
  }
}

function who(slot: number): string {
  if (slot === app.mySlot) return `<b>You</b>`;
  const look = app.looks[slot];
  return look ? `<b style="color:${look.color}">${esc(look.name)}</b>` : "<b>Someone</b>";
}

function feedText(slot: number, by: number, why: DeathCause): string {
  const victim = who(slot);
  const you = slot === app.mySlot;
  switch (why) {
    case "trail":
      return `${who(by)} cut ${victim}`;
    case "squeeze":
      return by >= 0 ? `${who(by)} squeezed out ${victim}` : `${victim} lost all ${you ? "your" : "their"} land`;
    case "self":
      return `${victim} crossed ${you ? "your" : "their"} own trail`;
    case "wall":
      return `${victim} hit the edge`;
    case "headon":
      return by >= 0 ? `${victim} and ${who(by).replace("<b>You</b>", "<b>you</b>")} collided` : `${victim} collided`;
    default:
      return "";
  }
}

function applyState(s: GameState): void {
  const prev = app.state;
  app.state = s;
  const mine = me(s);
  if (s.phase === "playing") {
    const looks = Array<Look | null>(MAX_PLAYERS).fill(null);
    for (const p of s.players) if (p.slot >= 0) looks[p.slot] = { color: p.color, name: p.name };
    app.looks = looks;
    app.mySlot = mine?.slot ?? -1;
  }
  if (s.phase === "lobby") {
    app.view = null;
    app.feed = [];
  }
  if (prev?.phase === "playing" && s.phase === "results" && s.results?.winnerId === app.me) sfx.win();
  document.title = s.phase === "playing" ? `Turf War · ${s.code}` : `Turf War · ${s.code} · ${s.phase}`;
  render();
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (app.screen === "home") {
    attract.frame(now);
    return;
  }
  if (app.screen !== "game" || !app.view) return;
  const scene = sceneNow();
  const key = app.looks.map((l) => l?.color ?? "").join();
  if (app.painted !== app.view.n || key !== app.paintKey) {
    renderer.paint(scene);
    app.painted = app.view.n;
    app.paintKey = key;
  }
  renderer.draw(scene, now);
  renderBanner();
  ageFeed(now);
}

function sceneNow(): Scene {
  return { board: app.view!.board, looks: app.looks, me: app.mySlot };
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
  roundSeconds: { label: "Round", fmt: (v: number) => `${v / 60} minute${v === 60 ? "" : "s"}` },
  board: {
    label: "Board",
    fmt: (v: BoardSize) => `${v[0].toUpperCase()}${v.slice(1)} · ${BOARD_SIZES[v].w} × ${BOARD_SIZES[v].h}`,
  },
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
        p.wins ? `<span class="tag">${p.wins} win${p.wins > 1 ? "s" : ""}</span>` : "",
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
  const size = app.view?.board ?? BOARD_SIZES[s.settings.board];
  $("round-label").textContent = `Round ${s.round} · ${size.w} × ${size.h}`;
  renderHud();
  renderScoreboard();
  renderResults(s);
}

/** Slots in the round, biggest land first. */
function standings(): { slot: number; land: number }[] {
  const v = app.view;
  if (!v) return [];
  return app.looks
    .map((l, slot) => (l ? { slot, land: v.board.land[slot] } : null))
    .filter((x): x is { slot: number; land: number } => !!x)
    .sort((a, b) => b.land - a.land || a.slot - b.slot);
}

function renderHud(): void {
  const s = app.state;
  const v = app.view;
  if (!s || app.screen !== "game") return;
  const mine = me(s);
  const clockEl = $("hud-clock");
  if (v && s.phase === "playing") {
    const left = v.end - Math.max(v.n, v.go);
    clockEl.textContent = clock(left);
    clockEl.classList.toggle("low", left <= 10 * TICKS_PER_SEC);
  } else {
    clockEl.textContent = s.phase === "results" ? "0:00" : "—";
    clockEl.classList.remove("low");
  }

  const slot = app.mySlot;
  const main = $("hud-main");
  let html: string;
  if (!mine || (s.phase === "playing" && slot < 0) || mine.spectator) {
    html = `<span class="note">Watching${mine?.spectator ? " — all 8 seats are taken; you'll get one between rounds if a seat frees up" : ""}</span>`;
    $("hud-land").textContent = "—";
    $("hud-kills").textContent = "—";
  } else {
    const ranks = standings();
    const rank = ranks.findIndex((r) => r.slot === slot) + 1;
    const h = myHead();
    const state = !v
      ? ""
      : h?.alive
        ? v.board.trails[slot].length
          ? `out · ${v.board.trails[slot].length}`
          : "home"
        : "respawning";
    html =
      `<span class="chip" style="background:${mine.color}"></span><span>${esc(mine.name)}</span>` +
      (rank ? `<span class="tag">#${rank} of ${ranks.length}</span>` : "") +
      (state ? `<span class="note">${state}</span>` : "");
    $("hud-land").textContent = v && slot >= 0 ? percent(v.board.land[slot], v.board.size) : "—";
    $("hud-kills").textContent = v && slot >= 0 ? String(v.kills[slot]) : "—";
  }
  if (main.innerHTML !== html) main.innerHTML = html;
}

let lastBoardHtml = "";
let lastMiniHtml = "";
function renderScoreboard(): void {
  const v = app.view;
  if (!v || app.screen !== "game") return;
  const rows = standings();
  const lead = Math.max(1, rows[0]?.land ?? 1);
  const html = rows
    .map(({ slot, land }) => {
      const look = app.looks[slot]!;
      const head = v.board.heads[slot];
      const you = slot === app.mySlot;
      const status = head.alive ? "" : " · respawning";
      return `<li class="${you ? "me" : ""} ${head.alive ? "" : "dead"}">
        <span class="chip" style="background:${look.color}"></span>
        <span class="pname">${esc(look.name)}${you ? ` <span class="tag tag-you">you</span>` : ""}</span>
        <span class="pct">${percent(land, v.board.size)}</span>
        <span class="meta">${v.kills[slot]} kill${v.kills[slot] === 1 ? "" : "s"} · ${v.deaths[slot]} death${v.deaths[slot] === 1 ? "" : "s"}${status}</span>
        <span class="bar"><i style="width:${(land / lead) * 100}%;background:${look.color}"></i></span>
      </li>`;
    })
    .join("");
  if (html !== lastBoardHtml) {
    lastBoardHtml = html;
    $("scoreboard").innerHTML = html;
  }

  // The compact board over the stage on small screens: the top three, and you.
  const top = rows.slice(0, 3);
  const mineRow = rows.find((r) => r.slot === app.mySlot);
  if (mineRow && !top.includes(mineRow)) top.push(mineRow);
  const mini = top
    .map(({ slot, land }) => {
      const look = app.looks[slot]!;
      const rank = rows.indexOf(rows.find((r) => r.slot === slot)!) + 1;
      return `<li class="${slot === app.mySlot ? "me" : ""}"><span>${rank}.</span><span class="chip" style="background:${look.color}"></span>
        <span>${slot === app.mySlot ? "You" : esc(look.name)}</span><span>${percent(land, v.board.size)}</span></li>`;
    })
    .join("");
  if (mini !== lastMiniHtml) {
    lastMiniHtml = mini;
    $("mini-board").innerHTML = mini;
  }
}

function renderFeed(): void {
  $("feed").innerHTML = app.feed.map((f) => `<li data-at="${f.at}">${f.html}</li>`).join("");
}

function ageFeed(now: number): void {
  const old = app.feed.filter((f) => now - f.at > 5000);
  if (!old.length) return;
  for (const li of $$("#feed li")) if (now - Number(li.dataset.at) > 4400) li.classList.add("old");
  if (old.some((f) => now - f.at > 5200)) {
    app.feed = app.feed.filter((f) => now - f.at <= 5200);
    renderFeed();
  }
}

/** The big message over the board: countdown, GO, why you died, time's up. */
function renderBanner(): void {
  const v = app.view;
  const s = app.state;
  let big = "";
  let sub = "";
  let sound = "";
  if (v && s?.phase === "playing") {
    const h = myHead();
    if (v.n < v.go) {
      const n = Math.ceil((v.go - v.n) / TICKS_PER_SEC);
      big = String(n);
      sub = app.mySlot >= 0 ? "Leave your land to draw a trail · come back to claim what it encloses" : "";
      sound = `count${n}`;
    } else if (v.n >= v.end) {
      big = "TIME!";
    } else if (v.n < v.go + TICKS_PER_SEC * 0.8 && app.mySlot >= 0) {
      big = "GO!";
      sound = "go";
    } else if (h && !h.alive && h.respawnAt > v.n) {
      const secs = Math.ceil((h.respawnAt - v.n) / TICKS_PER_SEC);
      big = deathTitle();
      sub = `Respawning in ${secs}… your land is gone, you'll start fresh`;
    }
  }
  if (sound && sound !== app.sounded) {
    app.sounded = sound;
    if (sound === "go") sfx.go();
    else sfx.count();
  }
  const key = `${big}|${sub}`;
  if (key === app.bannerKey) return;
  app.bannerKey = key;
  const el = $("banner");
  el.hidden = !big;
  el.innerHTML = big ? `<div class="big">${esc(big)}</div>${sub ? `<div class="sub">${sub}</div>` : ""}` : "";
}

function deathTitle(): string {
  const d = app.death;
  const name = (slot: number) => app.looks[slot]?.name ?? "someone";
  if (!d) return "OUT!";
  switch (d.why) {
    case "trail":
      return `CUT BY ${name(d.by).toUpperCase()}`;
    case "squeeze":
      return d.by >= 0 ? `SQUEEZED OUT BY ${name(d.by).toUpperCase()}` : "SQUEEZED OUT";
    case "self":
      return "YOU CROSSED YOUR OWN TRAIL";
    case "wall":
      return "YOU HIT THE EDGE";
    case "headon":
      return d.by >= 0 ? `HEAD-ON WITH ${name(d.by).toUpperCase()}` : "HEAD-ON!";
    default:
      return "OUT!";
  }
}

function renderResults(s: GameState): void {
  const r = s.results;
  const open = s.phase === "results" && !!r;
  $("results").hidden = !open;
  if (!open || !r) return;
  $("results-title").textContent = `Round ${r.round} results`;
  const winner = r.standings.find((x) => x.id === r.winnerId);
  $("results-winner").innerHTML = winner
    ? `<b style="color:${winner.color}">${esc(winner.id === app.me ? "You" : winner.name)}</b> ${winner.id === app.me ? "take" : "takes"} the board with ${percent(winner.cells, r.cells)}.`
    : "It's a draw.";
  $("results-rows").innerHTML = r.standings
    .map((x, i) => {
      const p = playerById(x.id);
      return `<tr class="${x.id === r.winnerId ? "winner" : ""}">
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${x.color}"></span>${esc(x.name)}${x.id === app.me ? ` <span class="tag tag-you">you</span>` : ""}</span></td>
        <td>${percent(x.cells, r.cells)}</td><td>${percent(x.best, r.cells)}</td><td>${x.kills}</td><td>${x.deaths}</td><td>${p?.wins ?? "—"}</td></tr>`;
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
      : "Need at least two players for another round — add a CPU from the lobby."
    : `Waiting for ${playerById(s.hostId)?.name ?? "the host"} to start the next round…`;
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

/** Size the canvas: the whole board when it fits at a playable size, otherwise the space below the HUD. */
function layoutStage(): void {
  if (app.screen !== "game") return;
  const stage = $("stage");
  const width = stage.clientWidth;
  if (!width) return;
  app.stageWidth = width;
  const top = stage.getBoundingClientRect().top + window.scrollY;
  const narrow = window.innerWidth <= 760;
  const room = Math.max(260, window.innerHeight - top - (narrow ? 10 : 40));
  const size = app.view?.board ?? (app.state ? BOARD_SIZES[app.state.settings.board] : null);
  let height = room;
  if (size) {
    const cell = Math.min(width / size.w, room / size.h);
    if (cell >= 7) height = Math.min(room, Math.ceil(cell * size.h));
  }
  renderer.resize(width, height);
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  window.addEventListener("popstate", route);
  window.addEventListener("resize", () => (app.screen === "home" ? attract.resize() : layoutStage()));
  new ResizeObserver(() => {
    if (app.screen === "game" && $("stage").clientWidth !== app.stageWidth) layoutStage();
  }).observe($("stage"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") app.conn?.nudge();
  });
  for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, unlockAudio, { passive: true });

  // Home
  $("home-name").addEventListener("change", (e) => store("tw.name", (e.target as HTMLInputElement).value.trim()));
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
      // Hand the keyboard back to the board after chatting mid-round.
      if (inPlay()) input.blur();
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
    const value = key === "board" ? el.value : Number(el.value);
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

if (import.meta.env.DEV) Object.assign(window, { __tw: { app, renderer } });
