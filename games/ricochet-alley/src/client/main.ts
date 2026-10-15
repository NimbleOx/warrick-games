import type { CpuLevel } from "../shared/ai";
import { CODE_RE, MAX_BULLETS, MAX_PLAYERS, MUZZLE, PLAYER_COLORS, type MazeSize } from "../shared/constants";
import { COS, SIN } from "../shared/headings";
import {
  SETTING_CHOICES,
  rankPlayers,
  type GameState,
  type LogEntry,
  type PlayerState,
  type ServerMsg,
  type Settings,
} from "../shared/protocol";
import type { WorldSnapshot } from "../shared/sim";
import { isMuted, setMuted, sfx, unlockAudio } from "./audio";
import { Controls } from "./input";
import { LocalMatch } from "./local";
import { Connection, type NetStatus } from "./net";
import { Renderer } from "./render";
import { NetRound } from "./round";

// ------------------------------------------------------------------ helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Dev aid: `?as=bob` makes this tab a separate player (its own token, name and last game), so one browser
 * can be several players. Kept in sessionStorage, which is per tab, so it survives navigation and reloads.
 */
const devAs = (() => {
  if (!import.meta.env.DEV) return "";
  try {
    const as = new URLSearchParams(location.search).get("as") ?? sessionStorage.getItem("ra.as") ?? "";
    if (as) sessionStorage.setItem("ra.as", as);
    return as.replace(/\W/g, "").slice(0, 16);
  } catch {
    return "";
  }
})();

function store(key: string, value?: string | null): string | null {
  if (devAs) key = `${key}.${devAs}`;
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
  let t = store("ra.token");
  if (!t || !/^[\w-]{8,64}$/.test(t)) {
    t = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    store("ra.token", t);
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
  round: null as NetRound | null,
  /** Input sequence number for this connection; the server acks the latest it has applied. */
  seq: 0,
  /** Local time until which a status banner (GO!, you were hit) stays up. */
  flash: { html: "", until: 0 },
  lastCount: -1,
  /** Which tanks were alive when the HUD and scores were last drawn. */
  aliveKey: "",
  sandbox: null as LocalMatch | null,
};

const token = playerToken();
if (devAs && !store("ra.name")) store("ra.name", devAs);
const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attractRenderer = new Renderer($<HTMLCanvasElement>("attract"));
const attract = new LocalMatch(attractRenderer, { human: false, cpus: ["hard", "normal", "hard", "normal"], size: "large", sound: false });

const serverNow = () => Date.now() + app.skew;
const me = (s = app.state): PlayerState | undefined => s?.players.find((p) => p.id === app.me);
const playerById = (id: string | null | undefined) => app.state?.players.find((p) => p.id === id);
const canHost = (s = app.state) => {
  if (!s) return false;
  if (s.hostId === app.me) return true;
  const host = s.players.find((p) => p.id === s.hostId);
  return !host || !host.connected;
};

const controls = new Controls(
  {
    change: (bits) => {
      if (app.sandbox) {
        app.sandbox.humanBits = bits;
        return;
      }
      app.seq++;
      app.round?.input(app.seq, bits);
      app.conn?.send({ t: "in", s: app.seq, b: bits });
    },
    fire,
    active: () => app.screen === "game" && (!!app.sandbox || app.state?.phase === "playing" || app.state?.phase === "countdown"),
    heading: () => {
      if (app.sandbox) return app.sandbox.world.tanks[0].alive ? app.sandbox.world.tanks[0].h : null;
      return app.round?.myAlive ? (app.round.predictor.pose?.h ?? null) : null;
    },
  },
  { stick: $("stick"), knob: $("stick-knob"), fire: $("touch-fire") },
);

// ------------------------------------------------------------------ routing

function route(): void {
  const m = location.pathname.match(/^\/g\/([A-Za-z0-9]{5})\/?$/);
  const code = m?.[1].toUpperCase();
  if (code && CODE_RE.test(code)) {
    // Coming back to a game you were in (reload, reconnect): straight back in.
    if (store("ra.lastGame") === code && store("ra.name")) void joinGame(code);
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
  if (screen === "game") {
    $("touch").hidden = !matchMedia("(pointer: coarse)").matches;
    layoutStage();
  } else {
    controls.releaseAll();
  }
  if (screen === "home") resizeAttract();
}

function showHome(inviteCode: string | null): void {
  disconnect();
  showScreen("home");
  document.title = "Ricochet Alley";
  $("home-error").textContent = "";
  const nameInput = $<HTMLInputElement>("home-name");
  nameInput.value = store("ra.name") ?? "";
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
  store("ra.name", name);
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
  const name = store("ra.name") ?? readName();
  if (!name) return;
  try {
    const res = await fetch(`/api/games/${code}`);
    if (res.status === 404) {
      store("ra.lastGame", null);
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
  store("ra.lastGame", code);
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
    hello: () => ({ t: "hello", token, name: store("ra.name") ?? name }),
    message: onMessage,
    status: onStatus,
    fatal: (reason) => {
      store("ra.lastGame", null);
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
  app.round = null;
  $("gameover").hidden = true;
}

function leave(): void {
  const s = app.state;
  if (s && s.phase !== "lobby" && s.phase !== "gameover" && !me(s)?.spectator && !confirm("Leave this game? Your points go with you.")) return;
  app.conn?.send({ t: "leave" });
  store("ra.lastGame", null);
  history.pushState(null, "", "/");
  showHome(null);
}

function onStatus(status: NetStatus): void {
  for (const el of [$("lobby-conn"), $("game-conn")]) {
    el.dataset.status = status;
    el.textContent = status === "open" ? "" : status === "connecting" ? "Connecting…" : "Reconnecting…";
  }
  if (status !== "open") app.round?.clock.reset();
}

// ------------------------------------------------------------------ messages

function onMessage(msg: ServerMsg): void {
  if ("now" in msg) app.skew = msg.now - Date.now();
  switch (msg.t) {
    case "welcome":
      app.me = msg.you;
      app.log = msg.log;
      // A new connection starts input numbering over; re-send whatever is held right now.
      app.seq = 0;
      app.round = null;
      applyState(msg.state);
      if (msg.world) startRound(msg.world);
      if (controls.bits) {
        app.seq++;
        (app.round as NetRound | null)?.input(app.seq, controls.bits);
        app.conn?.send({ t: "in", s: app.seq, b: controls.bits });
      }
      renderLog();
      break;
    case "state":
      applyState(msg.state);
      break;
    case "round":
      startRound(msg.world);
      break;
    case "f":
      app.round?.frame(msg, performance.now());
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
  if (s.phase === "lobby") app.round = null;
  if (prev?.phase !== s.phase) onPhase(prev, s);
  document.title = s.phase === "lobby" ? `Ricochet Alley · ${s.code}` : `Round ${s.round} · Ricochet Alley`;
  render();
}

function onPhase(prev: GameState | null, s: GameState): void {
  if (s.phase === "playing" && prev?.phase === "countdown") {
    sfx.go();
    flash(`<span class="big">GO!</span>`, 700);
  }
  if (s.phase === "roundover" && s.roundWinnerId === app.me) sfx.win();
}

function startRound(world: WorldSnapshot): void {
  const s = app.state;
  if (!s?.setup) return;
  app.round = new NetRound(s.setup, world, app.me, app.seq, controls.bits, {
    tankInfo: (i) => {
      const p = playerById(s.setup!.tanks[i]);
      return { name: p?.name ?? "?", color: p?.color ?? "#888888" };
    },
    fired: (b, mine) => {
      // Your own shot already flashed and banged when you pressed fire.
      if (mine) return;
      renderer.muzzle(b.x, b.y, performance.now());
      sfx.fire();
    },
    hit: (owner, victim, x, y) => {
      const r = app.round;
      if (!r) return;
      renderer.explode(x, y, playerById(r.setup.tanks[victim])?.color ?? "#ffffff", performance.now());
      sfx.boom();
      if (victim === r.me) {
        const by = playerById(r.setup.tanks[owner]);
        flash(owner === victim ? `<span class="big">OOPS</span>Your own bullet got you.` : `<span class="big">HIT</span>${esc(by?.name ?? "Someone")} got you.`, 1800);
      }
    },
    bounced: (x, y) => {
      renderer.spark(x, y, performance.now());
      bounceSound();
    },
  });
  renderer.setMaze(s.setup.maze, s.setup.theme);
  app.lastCount = -1;
  layoutStage();
  render();
}

let lastBounce = 0;
function bounceSound(): void {
  const now = performance.now();
  if (now - lastBounce < 60) return;
  lastBounce = now;
  sfx.bounce();
}

function fire(): void {
  if (app.sandbox) {
    app.sandbox.requestFire();
    return;
  }
  const r = app.round;
  const s = app.state;
  if (!r || !s || s.phase !== "playing" || !r.myAlive) return;
  if (r.myBullets() >= MAX_BULLETS) {
    sfx.empty();
    const pips = $("hud-pips");
    pips.classList.remove("empty");
    void pips.offsetWidth;
    pips.classList.add("empty");
    return;
  }
  app.conn?.send({ t: "in", s: app.seq, b: controls.bits, f: 1 });
  const p = r.predictor.pose;
  if (p) renderer.muzzle(p.x + COS[p.h] * MUZZLE, p.y + SIN[p.h] * MUZZLE, performance.now());
  sfx.fire();
}

function flash(html: string, ms: number): void {
  app.flash = { html, until: performance.now() + ms };
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (app.screen === "home") {
    attract.frame(now);
    return;
  }
  if (app.screen !== "game") return;
  controls.update();
  if (app.sandbox) {
    app.sandbox.frame(now);
    renderSandboxHud();
    return;
  }
  const r = app.round;
  const s = app.state;
  if (r && s) {
    r.update(now, s.phase === "playing", () => controls.update());
    const { tanks, bullets } = r.draw(now);
    renderer.draw({ tanks, bullets, findMe: s.phase === "countdown", names: s.phase === "countdown" || s.phase === "roundover" }, now);
    renderPips(r);
    // Tanks fall between state messages; keep the HUD and the score list in step.
    const key = r.alive.join();
    if (key !== app.aliveKey) {
      app.aliveKey = key;
      renderGame(s);
    }
  }
  renderBanner(now);
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
  target: { label: "First to", fmt: (v: number) => `${v} point${v === 1 ? "" : "s"}` },
  maze: {
    label: "Maze",
    fmt: (v: string) => ({ auto: "Auto — grows with players", small: "Small (7×5)", medium: "Medium (9×6)", large: "Large (12×8)" })[v] ?? v,
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
        p.spectator ? `<span class="tag">watching — game full</span>` : "",
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
    b.title = b.disabled ? `The game is full (${MAX_PLAYERS} tanks)` : "";
  }

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
      ? "You need at least two tanks. Invite a friend or add a CPU."
      : ""
    : `Waiting for ${hostName} to start the game…`;
}

// ------------------------------------------------------------------ game

function renderGame(s: GameState): void {
  renderHud(s);
  renderPlayers(s);
  renderGameOver(s);
}

function renderHud(s: GameState): void {
  $("hud-round").textContent = s.round ? String(s.round) : "—";
  $("hud-target").textContent = String(s.settings.target);
  const r = app.round;
  const mine = me(s);
  const left = r?.aliveCount ?? 0;
  let html: string;
  if (mine?.spectator) {
    const full = s.players.filter((p) => !p.spectator).length >= MAX_PLAYERS;
    html = full ? `<span class="dim">Watching — the game is full (${MAX_PLAYERS} tanks)</span>` : `<span class="dim">Watching — you're in from the next round</span>`;
  } else if (s.phase === "countdown") {
    html = `<span class="who">Round ${s.round}</span><span class="dim">Get ready…</span>`;
  } else if (s.phase === "playing") {
    if (r && r.me >= 0 && !r.myAlive) html = `<span class="who">You're out</span><span class="dim">${left} tank${left === 1 ? "" : "s"} left</span>`;
    else if (r && r.me < 0) html = `<span class="dim">You sat this round out — you're in next round</span>`;
    else html = `<span class="who">Round ${s.round}</span><span class="dim">${left} tanks left</span>`;
  } else if (s.phase === "roundover") {
    const w = playerById(s.roundWinnerId);
    html = w ? `<span class="chip" style="background:${w.color}"></span><span class="who">${esc(w.name)} wins the round</span>` : `<span class="who">Draw — nobody survived</span>`;
  } else {
    html = `<span class="who">Game over</span>`;
  }
  const el = $("hud-status");
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

function renderPips(r: NetRound): void {
  const left = r.me >= 0 && r.myAlive ? MAX_BULLETS - r.myBullets() : 0;
  const key = String(left);
  const el = $("hud-pips");
  if (el.dataset.left === key) return;
  el.dataset.left = key;
  el.innerHTML = Array.from({ length: MAX_BULLETS }, (_, i) => `<i class="${i < left ? "" : "out"}"></i>`).join("");
  el.setAttribute("aria-label", `${left} of ${MAX_BULLETS} bullets ready`);
  $("touch-fire").classList.toggle("out", left === 0);
}

function renderPlayers(s: GameState): void {
  const r = app.round;
  const ranked = [...s.players].sort((a, b) => Number(a.spectator) - Number(b.spectator) || rankPlayers(a, b));
  const html = ranked
    .map((p) => {
      const i = r ? r.setup.tanks.indexOf(p.id) : -1;
      const out = s.phase !== "lobby" && (i < 0 || (r && !r.alive[i]));
      const tags = [
        p.id === app.me ? `<span class="tag tag-you">you</span>` : "",
        p.cpu ? `<span class="tag">CPU</span>` : "",
        p.spectator ? `<span class="tag">next round</span>` : "",
        !p.cpu && !p.connected ? `<span class="tag">away</span>` : "",
      ].join("");
      const pct = Math.min(100, (p.score / s.settings.target) * 100);
      return `<li class="${[out ? "dead" : "", p.id === app.me ? "me" : "", !p.cpu && !p.connected ? "offline" : ""].join(" ")}">
        <span class="chip" style="background:${p.color}"></span>
        <span class="pname">${esc(p.name)} ${tags}</span>
        <span class="pts">${p.score}</span>
        <span class="bar"><i style="width:${pct}%;background:${p.color}"></i></span></li>`;
    })
    .join("");
  const el = $("game-players");
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

function renderBanner(now: number): void {
  const s = app.state;
  const el = $("banner");
  let html = "";
  let cls = "banner";
  if (s?.phase === "countdown" && s.phaseDeadline) {
    const secs = Math.max(1, Math.ceil((s.phaseDeadline - serverNow()) / 1000));
    if (secs !== app.lastCount) {
      app.lastCount = secs;
      sfx.beep();
    }
    html = `<span class="big">${secs}</span><span class="sub">Round ${s.round}</span>`;
    cls += " count";
  } else if (s?.phase === "roundover") {
    const w = playerById(s.roundWinnerId);
    const champ = s.players.find((p) => !p.spectator && p.score >= s.settings.target);
    const next = s.phaseDeadline ? Math.max(0, Math.ceil((s.phaseDeadline - serverNow()) / 1000)) : 0;
    const title = w ? (w.id === app.me ? "You win the round!" : `${esc(w.name)} wins the round`) : "Draw!";
    const sub = champ ? `…and that's the game.` : w ? `${w.score} of ${s.settings.target} · next round in ${next}` : `Nobody scores · next round in ${next}`;
    html = `<span class="big" style="${w ? `color:${w.color}` : ""}">${title}</span><span class="sub">${sub}</span>`;
  } else if (app.flash.until > now) {
    html = app.flash.html;
    cls += " flash";
  }
  if (el.dataset.html === html + cls) return;
  el.dataset.html = html + cls;
  el.className = cls;
  el.innerHTML = html;
  el.hidden = !html;
}

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover";
  $("gameover").hidden = !open;
  if (!open) return;
  const ranked = s.players.filter((p) => !p.spectator).sort(rankPlayers);
  const best = ranked[0];
  $("gameover-winner").innerHTML = best ? `<b style="color:${best.color}">${esc(best.name)}</b> rules the alley.` : "";
  $("gameover-rows").innerHTML = ranked
    .map(
      (p, i) => `<tr>
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${p.color}"></span>${esc(p.name)}</span></td>
        <td>${p.score}</td><td>${p.kills}</td><td>${p.selfHits}</td></tr>`,
    )
    .join("");
  const back = $<HTMLButtonElement>("gameover-lobby");
  const host = canHost(s);
  back.disabled = !host;
  back.textContent = host ? "Back to lobby" : `Waiting for ${esc(playerById(s.hostId)?.name ?? "host")}…`;
  $("gameover-hint").textContent = host ? "" : "Only the host can take everyone back to the lobby.";
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
  if (app.screen !== "game") return;
  const col = $("stage-col");
  const stage = $("stage");
  const top = stage.getBoundingClientRect().top;
  const touch = $("touch");
  const below = (touch.hidden ? 0 : touch.offsetHeight + 10) + ($("keys-hint").offsetHeight || 0) + 28;
  renderer.fit(col.clientWidth - 4, Math.max(200, window.innerHeight - Math.max(0, top) - below));
}

function resizeAttract(): void {
  // Cover the whole screen: fit to the larger box, and let CSS crop the overflow.
  const w = window.innerWidth;
  const h = window.innerHeight;
  attractRenderer.fit(Math.max(w, h * 1.5), Math.max(h, w / 1.5));
  attractRenderer.canvas.style.width = "100%";
  attractRenderer.canvas.style.height = "100%";
}

// ------------------------------------------------------------------ sandbox (dev only)

function startSandbox(params: URLSearchParams): void {
  const cpus = (params.get("cpus") ?? "normal,normal,normal").split(",") as CpuLevel[];
  app.sandbox = new LocalMatch(renderer, { human: true, cpus, size: (params.get("size") ?? "medium") as MazeSize, sound: true });
  showScreen("game");
  $("hud-target").textContent = "—";
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyR" && app.sandbox) app.sandbox.newRound(performance.now());
  });
}

function renderSandboxHud(): void {
  const sb = app.sandbox!;
  const left = sb.world.tanks[0].alive ? MAX_BULLETS - sb.field.countOf(0) : 0;
  const el = $("hud-pips");
  if (el.dataset.left !== String(left)) {
    el.dataset.left = String(left);
    el.innerHTML = Array.from({ length: MAX_BULLETS }, (_, i) => `<i class="${i < left ? "" : "out"}"></i>`).join("");
  }
  $("hud-round").textContent = String(sb.round);
  const status = `<span class="dim">Sandbox · R for a new maze · wins ${sb.wins.join(" / ")}</span>`;
  if ($("hud-status").innerHTML !== status) $("hud-status").innerHTML = status;
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  window.addEventListener("popstate", route);
  window.addEventListener("resize", () => (app.screen === "home" ? resizeAttract() : layoutStage()));
  new ResizeObserver(() => layoutStage()).observe($("stage-col"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") app.conn?.nudge();
  });
  for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, unlockAudio, { passive: true });

  // Home
  $("home-name").addEventListener("change", (e) => store("ra.name", (e.target as HTMLInputElement).value.trim()));
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
      // Hand the keyboard back to the game.
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
    if (level) app.conn?.send({ t: "addCpu", level: level as CpuLevel });
  });
  $("lobby-colors").addEventListener("click", (e) => {
    const color = (e.target as HTMLElement).closest<HTMLElement>("[data-color]")?.dataset.color;
    if (color) app.conn?.send({ t: "color", color });
  });
  $("lobby-settings").addEventListener("change", (e) => {
    const el = e.target as HTMLSelectElement;
    const key = el.dataset.setting as keyof Settings | undefined;
    if (!key) return;
    const value = key === "maze" ? el.value : Number(el.value);
    app.conn?.send({ t: "settings", settings: { [key]: value } });
  });
  $("lobby-start").addEventListener("click", () => app.conn?.send({ t: "start" }));
  $("gameover-lobby").addEventListener("click", () => app.conn?.send({ t: "lobby" }));

  // Clicking the stage or a tank list shouldn't leave a button focused (it would swallow Space).
  $("stage").addEventListener("pointerdown", () => (document.activeElement as HTMLElement | null)?.blur());

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
const params = new URLSearchParams(location.search);
if (import.meta.env.DEV && params.has("sandbox")) startSandbox(params);
else route();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __ra: { app, renderer, controls } });
