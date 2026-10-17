import { snapTileSolid, type ArenaEvent, type ArenaSnap, type SnapPlayer } from "../shared/arena";
import { CODE_RE, FUSE_MS, MAX_PLAYERS, PLAYER_COLORS, SHORT_FUSE_MS } from "../shared/constants";
import { OPPOSITE, moveActor, overlaps, type BlockedFn, type Dir } from "../shared/movement";
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
import { Input } from "./input";
import { Connection, type NetStatus } from "./net";
import { CURSE_LABEL, Renderer, type ArenaView, type BombView, type BomberView } from "./render";

// ------------------------------------------------------------------ helpers

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
  let t = store("br.token");
  if (!t || !/^[\w-]{8,64}$/.test(t)) {
    t = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    store("br.token", t);
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

function setHtml(el: HTMLElement, html: string): void {
  if (el.dataset.html === html) return;
  el.innerHTML = html;
  el.dataset.html = html;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------------ app state

type Screen = "home" | "lobby" | "game";

/** One received frame, kept for interpolating everyone else's movement. */
interface FrameRec {
  time: number;
  players: Map<string, { x: number; y: number; f: Dir }>;
  bombs: Map<number, { x: number; y: number }>;
}

/** Where we think our own bomber is: moved locally every frame, corrected when the server says so. */
interface Local {
  x: number;
  y: number;
  face: Dir;
  fix: number;
}

/** Bombs we've dropped that the server hasn't confirmed yet. */
interface Pending {
  c: number;
  at: number;
  explodeAt: number;
}

/** Draw other bombers this far in the past, so there are frames on both sides to blend between. */
const INTERP_MS = 90;
const SEND_MS = 33;

const app = {
  screen: "home" as Screen,
  conn: null as Connection | null,
  code: "",
  me: "",
  state: null as GameState | null,
  log: [] as LogEntry[],
  /** Server wall clock minus ours, for the between-round countdown. */
  skew: 0,
  snap: null as ArenaSnap | null,
  frames: [] as FrameRec[],
  /** Arena time ≈ performance.now() + clock. */
  clock: NaN,
  local: null as Local | null,
  pending: [] as Pending[],
  sent: { x: NaN, y: NaN, d: 0 as Dir, at: 0 },
  drawn: new Map<string, BomberView>(),
  banner: { html: "", cls: "", until: 0 },
  countShown: -1,
  lastFrame: 0,
  winKey: "",
};

const token = playerToken();
const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));
const input = new Input(() => app.screen === "game", dropBomb);

const me = (s = app.state): PlayerState | undefined => s?.players.find((p) => p.id === app.me);
const playerById = (id: string | null | undefined) => app.state?.players.find((p) => p.id === id);
const mySnap = (f = app.snap): SnapPlayer | undefined => f?.players.find((p) => p.id === app.me);
const canHost = (s = app.state) => {
  if (!s) return false;
  if (s.hostId === app.me) return true;
  const host = s.players.find((p) => p.id === s.hostId);
  return !host || !host.connected;
};

function arenaNow(): number {
  const f = app.snap;
  if (!f) return 0;
  // Don't run on ahead if frames stop coming.
  return Math.min(performance.now() + app.clock, f.time + 300);
}

// ------------------------------------------------------------------ routing

function route(): void {
  const m = location.pathname.match(/^\/g\/([A-Za-z0-9]{5})\/?$/);
  const code = m?.[1].toUpperCase();
  if (code && CODE_RE.test(code)) {
    // Coming back to a game you were in (reload, reconnect): straight back in.
    if (store("br.lastGame") === code && store("br.name")) void joinGame(code);
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
  input.clear();
  if (screen === "game") layoutStage();
  if (screen === "home") attract.resize();
}

function showHome(inviteCode: string | null): void {
  disconnect();
  showScreen("home");
  document.title = "Boom Room";
  $("home-error").textContent = "";
  const nameInput = $<HTMLInputElement>("home-name");
  nameInput.value = store("br.name") ?? "";
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
  store("br.name", name);
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
  const name = store("br.name") ?? readName();
  if (!name) return;
  try {
    const res = await fetch(`/api/games/${code}`);
    if (res.status === 404) {
      store("br.lastGame", null);
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
  store("br.lastGame", code);
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
    hello: () => ({ t: "hello", token, name: store("br.name") ?? name }),
    message: onMessage,
    status: onStatus,
    fatal: (reason) => {
      store("br.lastGame", null);
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
  clearArena();
  $("gameover").hidden = true;
}

function clearArena(): void {
  app.snap = null;
  app.frames = [];
  app.local = null;
  app.pending = [];
  app.drawn.clear();
}

function leave(): void {
  const s = app.state;
  if (s && s.phase !== "lobby" && s.phase !== "gameover" && !confirm("Leave this game? You'll sit out the rest of it.")) return;
  app.conn?.send({ t: "leave" });
  store("br.lastGame", null);
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
      clearArena();
      applyState(msg.state);
      if (msg.frame) onFrame(msg.frame);
      renderLog();
      break;
    case "state":
      applyState(msg.state);
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

function applyState(s: GameState): void {
  const prev = app.state;
  app.state = s;
  if (s.phase === "lobby") clearArena();
  if (s.phase === "roundover" && prev?.phase === "playing") {
    if (s.roundWinnerId === app.me) sfx.win();
  }
  document.title = `Boom Room · ${s.code}`;
  render();
}

function onFrame(f: ArenaSnap): void {
  const now = performance.now();
  const prev = app.snap;
  const newRound = !prev || f.time < prev.time || f.cols !== prev.cols || f.rows !== prev.rows;
  if (newRound) {
    app.frames = [];
    app.local = null;
    app.pending = [];
    app.countShown = -1;
    app.clock = NaN;
    renderer.reset();
  }
  const sample = f.time - now;
  if (!Number.isFinite(app.clock) || Math.abs(sample - app.clock) > 400) app.clock = sample;
  // Lean towards the frames that arrived quickest; late ones are just network jitter.
  else app.clock += (sample - app.clock) * (sample > app.clock ? 0.3 : 0.03);

  app.frames.push({
    time: f.time,
    players: new Map(f.players.map((p) => [p.id, { x: p.x, y: p.y, f: p.f }])),
    bombs: new Map(f.bombs.map((b) => [b.id, { x: b.x, y: b.y }])),
  });
  if (app.frames.length > 40) app.frames.shift();
  app.snap = f;
  if (newRound) {
    if (app.screen === "game") layoutStage();
    else render();
  }

  const mine = mySnap(f);
  if (mine) {
    // The server overrode us (or this is the first we've heard): jump to where it says.
    if (!app.local || app.local.fix !== mine.fix) app.local = { x: mine.x, y: mine.y, face: mine.f, fix: mine.fix };
  } else {
    app.local = null;
  }
  app.pending = app.pending.filter(
    (pb) => now - pb.at < 700 && !f.bombs.some((b) => b.o === app.me && Math.round(b.y) * f.cols + Math.round(b.x) === pb.c),
  );

  for (const ev of f.ev) onArenaEvent(ev, f, now);
  renderHudStats();
  renderPlayers();
  renderParticipation();
}

let dropSound = 0;

function onArenaEvent(ev: ArenaEvent, f: ArenaSnap, now: number): void {
  switch (ev.e) {
    case "boom":
      sfx.boom(ev.n);
      break;
    case "pick":
      if (ev.id === app.me) ev.k === "skull" ? sfx.curse() : sfx.pickup();
      break;
    case "pass":
      if (ev.id === app.me) {
        sfx.curse();
        toast(`You caught ${CURSE_LABEL[ev.k]}!`, "info");
      }
      break;
    case "kick":
      sfx.kick();
      break;
    case "die":
      sfx.die();
      if (ev.id === app.me) flashBanner(`<span class="big">You're out!</span>Watch the rest of the round.`, 2200);
      break;
    case "hurry":
      sfx.hurry();
      flashBanner(`<span class="big">HURRY UP!</span>The walls are closing in.`, 2400, "hurry");
      break;
    case "drop":
      if (++dropSound % 3 === 0) sfx.drop();
      break;
    case "go":
      sfx.go();
      break;
  }
  renderer.onEvent(ev, f, now, (id) => {
    const d = app.drawn.get(id);
    return d ? { x: d.x, y: d.y, face: d.face, color: d.color } : null;
  });
}

// ------------------------------------------------------------------ moving & bombing

function bombCells(f: ArenaSnap): Set<number> {
  const cells = new Set(f.bombs.map((b) => Math.round(b.y) * f.cols + Math.round(b.x)));
  for (const pb of app.pending) cells.add(pb.c);
  return cells;
}

function blockedFor(f: ArenaSnap, from: { x: number; y: number }): BlockedFn {
  const bombs = bombCells(f);
  return (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= f.cols || cy >= f.rows) return true;
    const c = cy * f.cols + cx;
    if (snapTileSolid(f.grid[c])) return true;
    return bombs.has(c) && !overlaps(from.x, from.y, cx, cy);
  };
}

/** Move our own bomber right away (no waiting for the server), and tell the server where we went. */
function predict(dt: number, now: number): void {
  const s = app.state;
  const f = app.snap;
  const loc = app.local;
  const mine = mySnap(f);
  if (!s || !f || !loc || !mine?.alive || s.phase !== "playing" || arenaNow() < f.goAt) return;
  let dir = input.dir();
  if (mine.c === "reverse") dir = OPPOSITE[dir];
  if (dir) {
    moveActor(loc, dir, (mine.s * dt) / 1000, blockedFor(f, { x: loc.x, y: loc.y }));
    loc.face = dir;
  }
  const moved = loc.x !== app.sent.x || loc.y !== app.sent.y;
  const turned = dir !== app.sent.d;
  if ((moved && now - app.sent.at >= SEND_MS) || turned) {
    if (app.conn?.send({ t: "move", x: round3(loc.x), y: round3(loc.y), d: dir })) {
      app.sent = { x: loc.x, y: loc.y, d: dir, at: now };
    }
  }
}

function dropBomb(): void {
  unlockAudio();
  const s = app.state;
  const f = app.snap;
  const loc = app.local;
  const mine = mySnap(f);
  if (!s || !f || !loc || !mine?.alive || s.phase !== "playing") return;
  if (arenaNow() < f.goAt || mine.c === "nobomb") return;
  const c = Math.round(loc.y) * f.cols + Math.round(loc.x);
  const mineOut = f.bombs.filter((b) => b.o === app.me).length + app.pending.length;
  if (mineOut >= mine.b || bombCells(f).has(c) || snapTileSolid(f.grid[c])) return;
  const fuse = mine.c === "shortfuse" ? SHORT_FUSE_MS : FUSE_MS;
  app.pending.push({ c, at: performance.now(), explodeAt: arenaNow() + fuse });
  if (app.conn?.send({ t: "bomb", x: round3(loc.x), y: round3(loc.y), d: app.sent.d })) {
    app.sent.x = loc.x;
    app.sent.y = loc.y;
  }
  sfx.place();
}

// ------------------------------------------------------------------ frame loop

let lastNow = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(50, lastNow ? now - lastNow : 16);
  lastNow = now;
  input.pollGamepad();
  if (app.screen === "home") {
    attract.frame(now);
    return;
  }
  if (app.screen !== "game") return;
  if (app.snap && app.state && app.state.phase !== "lobby") {
    predict(dt, now);
    renderer.draw(buildView(), now);
  }
  tickClocks(now);
}

function buildView(): ArenaView {
  const f = app.snap!;
  const s = app.state!;
  const t = arenaNow();
  const rt = t - INTERP_MS;
  const fr = app.frames;
  let a = fr[fr.length - 1];
  let b = a;
  for (let i = fr.length - 1; i > 0; i--) {
    if (fr[i - 1].time <= rt) {
      a = fr[i - 1];
      b = fr[i];
      break;
    }
    a = b = fr[i - 1];
  }
  const k = b.time > a.time ? Math.min(1, Math.max(0, (rt - a.time) / (b.time - a.time))) : 1;
  const lerp = <T extends { x: number; y: number }>(pa: T | undefined, pb: T | undefined, x: number, y: number) => {
    if (!pa || !pb || Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y) > 2) return { x, y };
    return { x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k };
  };

  const bombers: BomberView[] = f.players.map((p) => {
    const pl = playerById(p.id);
    let pos = { x: p.x, y: p.y };
    let face = p.f;
    if (p.id === app.me && app.local) {
      pos = app.local;
      face = app.local.face;
    } else {
      pos = lerp(a.players.get(p.id), b.players.get(p.id), p.x, p.y);
      face = b.players.get(p.id)?.f ?? p.f;
    }
    return {
      id: p.id,
      x: pos.x,
      y: pos.y,
      face,
      alive: p.alive,
      color: pl?.color ?? "#cccccc",
      name: pl?.name ?? "",
      you: p.id === app.me,
      curse: p.c,
    };
  });
  app.drawn = new Map(bombers.map((bv) => [bv.id, bv]));

  const bombs: BombView[] = f.bombs.map((bm) => {
    const pos = bm.s ? lerp(a.bombs.get(bm.id), b.bombs.get(bm.id), bm.x, bm.y) : bm;
    return { id: bm.id, x: pos.x, y: pos.y, at: bm.at, owner: bm.o };
  });
  for (const pb of app.pending) {
    bombs.push({ id: `pending${pb.c}`, x: pb.c % f.cols, y: Math.floor(pb.c / f.cols), at: pb.explodeAt, owner: app.me });
  }
  return {
    snap: f,
    time: Math.max(t, f.time),
    bombers,
    bombs,
    labels: true,
    cheer: s.phase === "roundover" ? s.roundWinnerId : null,
    colorOf: (id) => playerById(id)?.color ?? "#ffffff",
  };
}

function tickClocks(now: number): void {
  const s = app.state;
  if (!s || s.phase === "lobby") return;
  const f = app.snap;
  const t = arenaNow();
  const clock = document.querySelector<HTMLElement>("#hud-status .clock");
  if (clock && f) {
    let text = "";
    let hurry = false;
    if (s.phase === "playing" && f.hurryAt !== null) {
      const left = f.hurryAt - Math.max(t, f.goAt);
      hurry = left <= 0;
      text = hurry ? "HURRY!" : formatClock(left);
    }
    setText(clock, text);
    clock.classList.toggle("hurry", hurry);
  }
  if (s.phase === "roundover" && s.phaseDeadline) {
    const secs = String(Math.max(0, Math.ceil((s.phaseDeadline - (Date.now() + app.skew)) / 1000)));
    for (const el of $$("[data-countdown]")) setText(el, secs);
  }
  // Countdown beeps.
  if (f && s.phase === "playing" && t < f.goAt) {
    const n = Math.ceil((f.goAt - t) / 1000);
    if (n !== app.countShown && n <= 3) {
      app.countShown = n;
      sfx.count();
    }
  }
  renderBanner(now);
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
  wins: { label: "First to", fmt: (v: number) => `${v} win${v > 1 ? "s" : ""}` },
  hurrySeconds: {
    label: "Hurry up",
    fmt: (v: number) => (v ? `After ${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}` : "Never"),
  },
  crates: { label: "Crates", fmt: (v: string) => ({ sparse: "Sparse", normal: "Normal", packed: "Packed" })[v] ?? v },
  items: { label: "Power-ups", fmt: (v: string) => ({ few: "Few", normal: "Normal", lots: "Lots" })[v] ?? v },
  skulls: { label: "Skulls", fmt: (v: boolean) => (v ? "On — curses spread" : "Off") },
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
  for (const b of $$<HTMLButtonElement>("#lobby-cpu button")) b.disabled = participants.length >= MAX_PLAYERS;

  const mine = me(s);
  const taken = new Set(s.players.filter((p) => p.id !== app.me).map((p) => p.color));
  $("lobby-colors").innerHTML = PLAYER_COLORS.map(
    (c) => `<button class="swatch" style="background:${c}" data-color="${c}" aria-label="Color ${c}"
      aria-pressed="${mine?.color === c}" ${taken.has(c) ? "disabled" : ""}></button>`,
  ).join("");

  $("lobby-settings").innerHTML = (Object.keys(SETTING_LABELS) as (keyof Settings)[])
    .map((key) => {
      const { label, fmt } = SETTING_LABELS[key];
      const value = s.settings[key];
      const show = fmt as (v: unknown) => string;
      const control = host
        ? `<select data-setting="${key}">${(SETTING_CHOICES[key] as unknown[])
            .map((v) => `<option value="${String(v)}" ${v === value ? "selected" : ""}>${esc(show(v))}</option>`)
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
  renderHudStatus(s);
  renderHudStats();
  renderPlayers();
  renderGameOver(s);
  renderParticipation();
}

function renderHudStatus(s: GameState): void {
  let who = "";
  if (s.phase === "playing") {
    const mine = me(s);
    const label = !mine || mine.spectator ? "Watching" : !mine.inRound ? "Sitting this round out" : `Round ${s.round}`;
    who = `<span class="who">${label}</span>`;
  } else if (s.phase === "roundover") {
    const w = playerById(s.roundWinnerId);
    who = w
      ? `<span class="who"><span class="chip" style="background:${w.color}"></span>${esc(w.name)} wins!</span>`
      : `<span class="who">Draw</span>`;
  } else if (s.phase === "gameover") {
    who = `<span class="who">Game over</span>`;
  }
  setHtml($("hud-status"), `${who}<span class="clock"></span>`);
  setText($("hud-round"), s.round ? `${s.round}` : "—");
  setText($("game-target"), `first to ${s.settings.wins}`);
}

function renderHudStats(): void {
  const p = mySnap();
  const alive = !!p?.alive;
  setText($("hud-bombs"), alive ? String(p.b) : "—");
  setText($("hud-fire"), alive ? String(p.r) : "—");
  const speed = $("hud-speed");
  const kick = $("hud-kick");
  if (alive && p.c) {
    setText(speed, `${CURSE_LABEL[p.c]} ${Math.ceil(p.cl / 1000)}s`);
    speed.className = "curse";
    speed.title = "Cursed! Bump into someone to pass it on.";
  } else {
    setText(speed, alive ? String(p.sl + 1) : "—");
    speed.className = "";
    speed.title = "";
  }
  setText(kick, alive ? (p.k ? "Yes" : "No") : "—");
  kick.className = alive && p.k ? "on" : "";
}

function stars(n: number, of: number): string {
  const full = Math.min(n, of);
  return `${"★".repeat(full)}<span class="empty">${"★".repeat(Math.max(0, of - full))}</span>`;
}

function renderPlayers(): void {
  const s = app.state;
  if (!s || s.phase === "lobby") return;
  const f = app.snap;
  const rows = s.players
    .filter((p) => !p.spectator)
    .map((p) => {
      const sp = f?.players.find((q) => q.id === p.id);
      const inRound = !!sp && p.inRound;
      const dead = inRound && !sp!.alive;
      const cls = [
        dead ? "dead" : "",
        !inRound && s.phase === "playing" ? "out" : "",
        !p.cpu && !p.connected ? "offline" : "",
        s.phase === "roundover" && s.roundWinnerId === p.id ? "winner" : "",
      ].join(" ");
      const tag = p.id === app.me ? ` <span class="tag tag-you">you</span>` : p.cpu ? ` <span class="tag">CPU</span>` : "";
      let status = "";
      if (s.phase === "playing" || s.phase === "roundover") {
        if (!inRound) status = "sitting out";
        else if (dead) status = "K.O.";
        else
          status = `💣${sp!.b} 🔥${sp!.r} 👟${sp!.sl + 1}${sp!.k ? " · kick" : ""}${sp!.c ? ` · <span class="bad">☠ ${CURSE_LABEL[sp!.c]}</span>` : ""}`;
      }
      return `<li class="${cls}">
        <span class="chip" style="background:${p.color}"></span>
        <span class="pname">${esc(p.name)}${tag}</span>
        <span class="stars" title="${p.wins} round win${p.wins === 1 ? "" : "s"}">${stars(p.wins, s.settings.wins)}</span>
        ${status ? `<div class="status">${status}</div>` : ""}
      </li>`;
    });
  const spectators = s.players.filter((p) => p.spectator);
  if (spectators.length) {
    rows.push(`<li class="muted" style="display:block">Watching: ${spectators.map((p) => esc(p.name)).join(", ")}</li>`);
  }
  setHtml($("game-players"), rows.join(""));
}

function renderParticipation(): void {
  const s = app.state;
  if (!s) return;
  const p = me(s);
  const sp = mySnap();
  const playing = s.phase === "playing" && !!p && !p.spectator && p.inRound && !!sp?.alive;
  if ($("touchpad").hidden !== !playing) {
    $("touchpad").hidden = !playing;
    if (app.screen === "game") layoutStage();
  }
  const waiting = $("waiting");
  let text = "";
  if (s.phase === "playing") {
    if (!p || p.spectator) text = "You're watching this game. You'll get a bomber when the host starts the next one.";
    else if (!p.inRound) text = "You'll join in from the next round.";
    else if (sp && !sp.alive) text = "You're out this round. Hang tight for the next one.";
  }
  waiting.hidden = !text;
  setText(waiting, text);
}

function flashBanner(html: string, ms: number, cls = ""): void {
  app.banner = { html, cls, until: performance.now() + ms };
}

function renderBanner(now: number): void {
  const s = app.state;
  const f = app.snap;
  const el = $("banner");
  if (!s) return;
  let html = "";
  let cls = "";
  const t = arenaNow();
  if (s.phase === "roundover") {
    const winner = playerById(s.roundWinnerId);
    const head = winner
      ? `<span class="big" style="color:${winner.color}">${esc(winner.name)} wins round ${s.round}</span>`
      : `<span class="big">Round ${s.round} is a draw</span>`;
    const board = s.players
      .filter((p) => !p.spectator)
      .sort((a, b) => b.wins - a.wins)
      .map(
        (p) =>
          `<div><span class="chip" style="background:${p.color}"></span>${esc(p.name)}<span class="stars">${stars(p.wins, s.settings.wins)}</span></div>`,
      )
      .join("");
    const champion = s.players.some((p) => p.wins >= s.settings.wins);
    html = `${head}<div class="trophies">${board}</div>${champion ? "Final results" : "Next round"} in <span data-countdown></span>s`;
  } else if (s.phase === "playing" && f && t < f.goAt) {
    html = `<span class="count">${Math.ceil((f.goAt - t) / 1000)}</span>`;
    cls = "bare";
  } else if (s.phase === "playing" && f && t < f.goAt + 700) {
    html = `<span class="count">GO!</span>`;
    cls = "bare";
  } else if (app.banner.until > now) {
    html = app.banner.html;
    cls = `flash ${app.banner.cls}`;
  }
  if (!html) {
    el.hidden = true;
    el.dataset.html = "";
    return;
  }
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
    // Fill the countdown straight away rather than on the next tick.
    if (s.phaseDeadline) {
      for (const c of el.querySelectorAll<HTMLElement>("[data-countdown]")) {
        c.textContent = String(Math.max(0, Math.ceil((s.phaseDeadline - (Date.now() + app.skew)) / 1000)));
      }
    }
  }
  el.className = `banner ${cls}`;
  el.hidden = false;
}

// ------------------------------------------------------------------ game over

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover";
  $("gameover").hidden = !open;
  if (!open) return;
  const ranked = s.players.filter((p) => !p.spectator).sort(rankPlayers);
  const best = ranked[0];
  $("gameover-winner").innerHTML = best ? `<b style="color:${best.color}">${esc(best.name)}</b> rules the room.` : "";
  $("gameover-rows").innerHTML = ranked
    .map(
      (p, i) => `<tr>
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${p.color}"></span>${esc(p.name)}</span></td>
        <td>${p.wins}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.items}</td></tr>`,
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
  const touch = window.matchMedia("(pointer: coarse)").matches && !$("touchpad").hidden;
  // Keep everything on screen: cap the arena's width by the height that's left.
  const reserved = (window.innerWidth <= 760 ? 175 : 200) + (touch ? 175 : 0);
  const aspect = app.snap ? app.snap.cols / app.snap.rows : renderer.aspect;
  const maxByHeight = (window.innerHeight - reserved) * aspect;
  col.style.maxWidth = `${Math.max(300, Math.round(maxByHeight))}px`;
  col.style.margin = "0 auto";
  col.style.width = "100%";
  const f = app.snap;
  renderer.resize($("stage").clientWidth || col.clientWidth, f?.cols, f?.rows);
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
  $("home-name").addEventListener("change", (e) => store("br.name", (e.target as HTMLInputElement).value.trim()));
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
      const field = form.querySelector("input")!;
      const text = field.value.trim();
      if (text) app.conn?.send({ t: "chat", text });
      field.value = "";
      // Hand the keyboard back to the game.
      if (app.screen === "game") field.blur();
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
    const value = (SETTING_CHOICES[key] as unknown[]).find((v) => String(v) === el.value);
    if (value !== undefined) app.conn?.send({ t: "settings", settings: { [key]: value } });
  });
  $("lobby-start").addEventListener("click", () => app.conn?.send({ t: "start" }));

  // Game
  input.attachDpad($("dpad"));
  input.attachBombButton($("bomb-btn"));
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
  });
}

wire();
route();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __br: { app, renderer } });
