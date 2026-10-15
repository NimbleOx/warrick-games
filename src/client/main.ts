import { CODE_RE, MAX_PLAYERS, PLAYER_COLORS, TICK_MS, TURRET_Y } from "../shared/constants";
import {
  SETTING_CHOICES,
  rankPlayers,
  type Aim,
  type GameState,
  type LogEntry,
  type PlayerState,
  type ServerMsg,
  type Settings,
  type ShotMessage,
} from "../shared/protocol";
import { maxPowerFor, type World } from "../shared/sim";
import {
  SHOP_ORDER,
  WEAPONS,
  WEAPON_ORDER,
  shopDef,
  weaponCount,
  type ShopId,
  type WeaponId,
} from "../shared/weapons";
import { worldFromState } from "../shared/world-state";
import { Attract } from "./attract";
import { isMuted, setMuted, sfx, unlockAudio } from "./audio";
import { Connection, type NetStatus } from "./net";
import { Renderer, type DrawOpts, type TankInfo } from "./render";

// ------------------------------------------------------------------ helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
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
  let t = store("cc.token");
  if (!t || !/^[\w-]{8,64}$/.test(t)) {
    t = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    store("cc.token", t);
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

interface Anim {
  world: World;
  after: GameState;
  start: number;
  cursor: number;
}

const app = {
  screen: "home" as Screen,
  conn: null as Connection | null,
  code: "",
  me: "",
  state: null as GameState | null,
  log: [] as LogEntry[],
  skew: 0,
  aim: { angle: 60, power: 500, weapon: "baby_missile" } as Aim,
  turnKey: "",
  firing: false,
  world: null as World | null,
  anim: null as Anim | null,
  pending: null as GameState | null,
  dragging: false,
  aimGuide: null as DrawOpts["aimGuide"],
  bannerUntil: 0,
  shopRound: -1,
};

const token = playerToken();
const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));

const serverNow = () => Date.now() + app.skew;
const me = (s = app.state): PlayerState | undefined => s?.players.find((p) => p.id === app.me);
const playerById = (id: string | null | undefined) => app.state?.players.find((p) => p.id === id);
const isMyTurn = (s = app.state) => !!s && s.phase === "playing" && !s.resolving && s.turnPlayerId === app.me && !app.anim;
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
    if (store("cc.lastGame") === code && store("cc.name")) void joinGame(code);
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
  document.title = "Crater Club";
  $("home-error").textContent = "";
  const nameInput = $<HTMLInputElement>("home-name");
  nameInput.value = store("cc.name") ?? "";
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
  store("cc.name", name);
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
  const name = store("cc.name") ?? readName();
  if (!name) return;
  try {
    const res = await fetch(`/api/games/${code}`);
    if (res.status === 404) {
      store("cc.lastGame", null);
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
  store("cc.lastGame", code);
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
    hello: () => ({ t: "hello", token, name: store("cc.name") ?? name }),
    message: onMessage,
    status: onStatus,
    fatal: (reason) => {
      store("cc.lastGame", null);
      history.pushState(null, "", "/");
      showHome(null);
      $("home-error").textContent = reason;
    },
  });
}

function disconnect(): void {
  app.conn?.close();
  app.conn = null;
  app.anim = null;
  app.pending = null;
  app.state = null;
  app.world = null;
  $("shop").hidden = true;
  $("gameover").hidden = true;
}

function leave(): void {
  const s = app.state;
  if (s && s.phase !== "lobby" && s.phase !== "gameover" && !confirm("Leave this game? Your tank stays behind.")) return;
  app.conn?.send({ t: "leave" });
  store("cc.lastGame", null);
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
      app.anim = null;
      app.pending = null;
      applyState(msg.state);
      renderLog();
      break;
    case "state":
      if (app.anim) app.pending = msg.state;
      else applyState(msg.state);
      break;
    case "shot":
      startShot(msg.shot, msg.state);
      break;
    case "aim": {
      if (msg.id === app.me) break;
      for (const s of [app.state, app.pending]) {
        const p = s?.players.find((p) => p.id === msg.id);
        if (p) p.aim = msg.aim;
      }
      if (app.state?.turnPlayerId === msg.id) renderHud();
      break;
    }
    case "log":
      app.log.push(...msg.entries);
      if (app.log.length > 120) app.log.splice(0, app.log.length - 120);
      renderLog();
      break;
    case "error":
      app.firing = false;
      toast(msg.message);
      renderControls();
      break;
  }
}

function applyState(s: GameState): void {
  const prev = app.state;
  app.state = s;
  if (!prev || prev.round !== s.round || prev.phase === "lobby") renderer.clearTracers();
  app.world = s.terrain.length ? worldFromState(s) : null;

  const key = `${s.round}:${s.shotCount}:${s.turnPlayerId}`;
  if (isMyTurn(s) && key !== app.turnKey) {
    app.turnKey = key;
    const p = me(s)!;
    app.aim = { ...p.aim };
    app.firing = false;
    sfx.turn();
    flashBanner(`<span class="big">YOUR TURN</span>`, 1300);
  }
  if (!isMyTurn(s)) app.firing = false;

  document.title = isMyTurn(s) ? `▶ Your turn — Crater Club` : `Crater Club · ${s.code}`;
  render();
}

function startShot(shot: ShotMessage, after: GameState): void {
  if (app.anim) finishShot(true);
  const base = app.state;
  if (!base?.terrain.length) {
    applyState(after);
    return;
  }
  const shooter = base.players.find((p) => p.id === shot.shooterId);
  if (shooter) shooter.aim = { angle: shot.angle, power: shot.power, weapon: shot.weapon };
  const world = worldFromState(base);
  world.fire(shot);
  renderer.newShot();
  app.anim = { world, after, start: performance.now(), cursor: 0 };
  app.world = world;
  app.firing = false;
  app.dragging = false;
  app.aimGuide = null;
  render();
}

/** Stop animating: snap to the server's result (fast-forwarding if needed). */
function finishShot(skip = false): void {
  const a = app.anim;
  if (!a) return;
  if (skip) {
    a.world.runToEnd();
    a.cursor = a.world.events.length;
  }
  app.anim = null;
  applyState(a.after);
  if (app.pending) {
    const next = app.pending;
    app.pending = null;
    applyState(next);
  }
}

function drainEvents(a: Anim, now: number): void {
  const evs = a.world.events;
  for (; a.cursor < evs.length; a.cursor++) {
    const ev = evs[a.cursor];
    renderer.onEvent(ev, a.world, now, (id) => playerById(id)?.color ?? "#ffffff");
    if (ev.type === "fire") sfx.fire();
    else if (ev.type === "explode") ev.dirt ? sfx.dirt() : sfx.boom(ev.r);
    else if (ev.type === "split") sfx.split();
    else if (ev.type === "chute") sfx.chute();
  }
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (app.screen === "home") {
    attract.frame(now);
    return;
  }
  if (app.screen !== "game") return;

  const a = app.anim;
  if (a) {
    const target = Math.floor((now - a.start) / TICK_MS);
    let steps = 0;
    while (a.world.tick < target && !a.world.done && !a.world.timedOut && steps++ < 240) a.world.step();
    drainEvents(a, now);
    if (a.world.done || a.world.timedOut) finishShot();
  }
  if (app.world && app.state) renderer.draw(app.world, drawOpts(app.state), now);
  tickClocks();
}

function drawOpts(s: GameState): DrawOpts {
  const tanks = new Map<string, TankInfo>();
  const mine = isMyTurn(s);
  for (const p of s.players) {
    if (!p.tank) continue;
    tanks.set(p.id, {
      name: p.name,
      color: p.color,
      angle: p.id === app.me && mine ? app.aim.angle : p.aim.angle,
      active: s.phase === "playing" && s.turnPlayerId === p.id,
      you: p.id === app.me,
    });
  }
  const shooter = playerById(app.anim ? app.anim.world.shooterId : s.turnPlayerId);
  return { theme: s.theme, tanks, labels: true, aimGuide: app.aimGuide, shooterColor: shooter?.color };
}

function tickClocks(): void {
  const s = app.state;
  if (!s) return;
  const clock = document.querySelector<HTMLElement>("#hud-turn .clock");
  if (clock) {
    const left =
      s.turnDeadline && s.phase === "playing" && !s.resolving && !app.anim ? Math.max(0, s.turnDeadline - serverNow()) : null;
    const text = left === null ? "" : formatClock(left);
    if (clock.textContent !== text) clock.textContent = text;
    clock.classList.toggle("low", left !== null && left < 10000);
  }
  if (s.phase === "shop" || s.phase === "roundover") {
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
  startCash: { label: "Start cash", fmt: (v: number) => money(v) },
  maxWind: { label: "Wind", fmt: (v: number) => ({ 0: "Off", 5: "Light", 10: "Normal", 20: "Gale" })[v] ?? String(v) },
  walls: {
    label: "Walls",
    fmt: (v: string) => ({ open: "Open — shots fly off", bounce: "Rubber — shots bounce", wrap: "Wrap-around" })[v] ?? v,
  },
  turnSeconds: { label: "Turn timer", fmt: (v: number) => (v ? `${v} seconds` : "No limit") },
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
  renderHud();
  renderPlayers(s);
  renderControls();
  renderBanner();
  renderShop(s);
  renderGameOver(s);
}

function renderHud(): void {
  const s = app.state;
  if (!s || s.phase === "lobby") return;
  const turn = playerById(s.turnPlayerId);
  const turnEl = $("hud-turn");
  let who = "";
  if (s.phase === "playing" && turn) {
    const label =
      app.anim || s.resolving
        ? `${esc(turn.name)} fires!`
        : turn.id === app.me
          ? "Your turn!"
          : `${esc(turn.name)}'s turn${turn.cpu ? " (thinking…)" : ""}`;
    who = `<span class="chip" style="background:${turn.color}"></span><span class="who">${label}</span>`;
  } else if (s.phase === "roundover") who = `<span class="who">Round over</span>`;
  else if (s.phase === "shop") who = `<span class="who">Shopping break</span>`;
  else if (s.phase === "gameover") who = `<span class="who">Game over</span>`;
  const html = `${who}<span class="clock"></span>`;
  if (turnEl.dataset.html !== html) {
    turnEl.innerHTML = html;
    turnEl.dataset.html = html;
  }

  const aim = turn ? (turn.id === app.me && isMyTurn(s) ? app.aim : turn.aim) : null;
  const tank = turn?.tank;
  $("hud-angle").textContent = aim ? `${aim.angle}°` : "—";
  $("hud-power").textContent = aim ? String(aim.power) : "—";
  $("hud-power").title = tank ? `Max ${maxPowerFor(tank.health)} at ${tank.health} health` : "";
  $("hud-weapon").textContent = aim ? WEAPONS[aim.weapon].name : "—";
  $("hud-wind").textContent = s.wind === 0 ? "Calm" : `${s.wind > 0 ? "→" : "←"} ${Math.abs(s.wind)}`;
  $("hud-round").textContent = `${s.round}/${s.settings.rounds}`;
}

function renderPlayers(s: GameState): void {
  const order = s.turnOrder.length ? s.turnOrder : s.players.map((p) => p.id);
  const rows = order
    .map((id) => s.players.find((p) => p.id === id))
    .filter((p): p is PlayerState => !!p && !p.spectator)
    .map((p) => {
      const hp = p.tank?.health ?? 0;
      const cls = [
        s.turnPlayerId === p.id && s.phase === "playing" ? "turn" : "",
        p.tank && !p.tank.alive ? "dead" : "",
        !p.cpu && !p.connected ? "offline" : "",
      ].join(" ");
      const tag = p.id === app.me ? ` <span class="tag tag-you">you</span>` : p.cpu ? ` <span class="tag">CPU</span>` : "";
      const shield = p.tank?.alive && p.tank.shield > 0 ? ` <span class="tag" title="Shield">🛡 ${p.tank.shield}</span>` : "";
      return `<li class="${cls}">
        <span class="chip" style="background:${p.color}"></span>
        <span class="pname">${esc(p.name)}${tag}${shield}</span>
        <span class="cash">${money(p.money)}</span>
        <div class="hp"><i class="${hp > 60 ? "" : hp > 30 ? "mid" : "low"}" style="width:${hp}%"></i></div>
      </li>`;
    });
  const spectators = s.players.filter((p) => p.spectator);
  if (spectators.length) {
    rows.push(`<li class="muted" style="display:block">Watching: ${spectators.map((p) => esc(p.name)).join(", ")}</li>`);
  }
  $("game-players").innerHTML = rows.join("");
}

function renderControls(): void {
  const s = app.state;
  if (!s || s.phase === "lobby") return;
  const p = me(s);
  const controls = $("controls");
  const waiting = $("waiting");
  const playing = s.phase === "playing";
  const hasTank = !!p?.tank?.alive && !p.spectator;

  controls.hidden = !playing || !hasTank;
  waiting.hidden = !playing || hasTank;
  if (playing && !hasTank) {
    waiting.textContent = p?.spectator
      ? "You're watching this game. You'll get a tank when the host starts the next one."
      : "Your tank is scrap metal. Hang tight until the next round.";
  }
  if (!playing || !hasTank || !p) return;

  const mine = isMyTurn(s) && !app.firing;
  controls.classList.toggle("disabled", !mine);
  $("stage").classList.toggle("aiming", mine);

  const maxPower = maxPowerFor(p.tank!.health);
  if (app.aim.power > maxPower) app.aim.power = maxPower;
  if (weaponCount(p.inventory, app.aim.weapon) <= 0) app.aim.weapon = "baby_missile";

  const angle = $<HTMLInputElement>("ctl-angle");
  const power = $<HTMLInputElement>("ctl-power");
  // Range inputs run left-to-right; angle 180 points left, so mirror it.
  angle.value = String(180 - (mine ? app.aim.angle : p.aim.angle));
  power.max = String(maxPower);
  power.value = String(mine ? app.aim.power : p.aim.power);

  const select = $<HTMLSelectElement>("ctl-weapon");
  const owned = WEAPON_ORDER.filter((w) => weaponCount(p.inventory, w) > 0);
  const key = owned.map((w) => `${w}:${p.inventory[w] ?? "∞"}`).join(",");
  if (select.dataset.key !== key) {
    select.dataset.key = key;
    select.innerHTML = owned
      .map((w) => `<option value="${w}">${WEAPONS[w].name} (${w === "baby_missile" ? "∞" : p.inventory[w]})</option>`)
      .join("");
  }
  select.value = app.aim.weapon;
  $<HTMLButtonElement>("ctl-fire").disabled = !mine;
}

function flashBanner(html: string, ms: number): void {
  app.bannerUntil = performance.now() + ms;
  const el = $("banner");
  el.innerHTML = html;
  el.classList.add("flash");
  el.hidden = false;
}

function renderBanner(): void {
  const s = app.state;
  const el = $("banner");
  if (!s) return;
  if (s.phase === "roundover" && !app.anim) {
    el.classList.remove("flash");
    const winner = playerById(s.roundWinnerId);
    const head = winner
      ? `<span class="big" style="color:${winner.color}">${esc(winner.name)} wins round ${s.round}</span>`
      : `<span class="big">Round ${s.round}: nobody survived</span>`;
    const next = s.round >= s.settings.rounds ? "Final results" : "Arms dealer opens";
    el.innerHTML = `${head}${next} in <span data-countdown></span>s`;
    el.hidden = false;
    return;
  }
  const watching = !me(s) || me(s)!.spectator;
  if (s.phase === "shop" && watching) {
    el.classList.remove("flash");
    el.innerHTML = `<span class="big">Shopping break</span>Next round in <span data-countdown></span>s`;
    el.hidden = false;
    return;
  }
  if (app.bannerUntil) return; // transient banner still showing
  el.hidden = true;
}

// ------------------------------------------------------------------ shop

function renderShop(s: GameState): void {
  const p = me(s);
  const open = s.phase === "shop" && !!p && !p.spectator;
  $("shop").hidden = !open;
  if (!open || !p) {
    app.shopRound = -1;
    return;
  }
  const grid = $("shop-grid");
  if (app.shopRound !== s.round) {
    app.shopRound = s.round;
    grid.innerHTML = SHOP_ORDER.map((id) => {
      const d = shopDef(id);
      return `<div class="item" data-item="${id}">
        <h3>${d.name}</h3><span class="own"></span>
        <p>${esc(d.desc)}</p>
        <span class="price">${money(d.price)}${d.bundle > 1 ? ` <span class="muted">for ${d.bundle}</span>` : ""}</span>
        <div class="buy-row">
          <button class="btn btn-small" data-sell="${id}" aria-label="Sell ${d.name}">Sell</button>
          <button class="btn btn-small btn-primary" data-buy="${id}" aria-label="Buy ${d.name}">Buy</button>
        </div>
      </div>`;
    }).join("");
  }
  for (const card of $$("#shop-grid .item")) {
    const id = card.dataset.item as ShopId;
    const d = shopDef(id);
    const owned = p.inventory[id] ?? 0;
    card.classList.toggle("owned", owned > 0);
    card.querySelector(".own")!.textContent = owned ? `×${owned}` : "";
    card.querySelector<HTMLButtonElement>("[data-buy]")!.disabled = p.money < d.price;
    card.querySelector<HTMLButtonElement>("[data-sell]")!.disabled = owned < d.bundle;
  }
  $("shop-cash").textContent = money(p.money);
  $("shop-sub").innerHTML = `Round ${s.round} done. Round ${s.round + 1} starts in <span data-countdown></span>s or when everyone is ready.`;
  const ready = $<HTMLButtonElement>("shop-ready");
  ready.textContent = p.ready ? "Not ready yet" : "Ready";
  ready.classList.toggle("btn-primary", !p.ready);
  const waitingFor = s.players.filter((o) => !o.spectator && !o.cpu && o.connected && !o.ready).map((o) => esc(o.name));
  $("shop-waiting").innerHTML = waitingFor.length ? `Waiting for ${waitingFor.join(", ")}` : "Everyone's ready";
}

// ------------------------------------------------------------------ game over

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover";
  $("gameover").hidden = !open;
  if (!open) return;
  const ranked = s.players.filter((p) => !p.spectator).sort(rankPlayers);
  const best = ranked[0];
  $("gameover-winner").innerHTML = best
    ? `<b style="color:${best.color}">${esc(best.name)}</b> rules the crater.`
    : "";
  $("gameover-rows").innerHTML = ranked
    .map(
      (p, i) => `<tr>
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${p.color}"></span>${esc(p.name)}</span></td>
        <td>${p.score}</td><td>${p.wins}</td><td>${p.kills}</td><td>${p.damage}</td></tr>`,
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

// ------------------------------------------------------------------ aiming & firing

let aimSendTimer = 0;
let lastAimSent = 0;

function setAim(patch: Partial<Aim>): void {
  const s = app.state;
  const p = me(s);
  if (!s || !p?.tank || !isMyTurn(s) || app.firing) return;
  const next = { ...app.aim, ...patch };
  next.angle = Math.min(180, Math.max(0, Math.round(next.angle)));
  next.power = Math.min(maxPowerFor(p.tank.health), Math.max(0, Math.round(next.power)));
  if (weaponCount(p.inventory, next.weapon) <= 0) next.weapon = "baby_missile";
  app.aim = next;
  renderHud();
  renderControls();
  // Let the others watch the barrel move, without flooding the socket.
  const wait = 90 - (performance.now() - lastAimSent);
  clearTimeout(aimSendTimer);
  const sendNow = () => {
    lastAimSent = performance.now();
    app.conn?.send({ t: "aim", aim: app.aim });
  };
  if (wait <= 0) sendNow();
  else aimSendTimer = window.setTimeout(sendNow, wait);
}

function fire(): void {
  if (!isMyTurn() || app.firing) return;
  unlockAudio();
  clearTimeout(aimSendTimer);
  app.firing = true;
  app.dragging = false;
  app.aimGuide = null;
  app.conn?.send({ t: "fire", aim: app.aim });
  renderControls();
}

function cycleWeapon(dir: 1 | -1): void {
  const p = me();
  if (!p) return;
  const owned = WEAPON_ORDER.filter((w) => weaponCount(p.inventory, w) > 0);
  const i = owned.indexOf(app.aim.weapon);
  setAim({ weapon: owned[(i + dir + owned.length) % owned.length] });
}

function aimFromPointer(e: PointerEvent): void {
  const tank = me()?.tank;
  if (!tank) return;
  const w = renderer.toWorld(e.clientX, e.clientY);
  const x0 = tank.x;
  const y0 = tank.y + TURRET_Y;
  const dx = w.x - x0;
  const dy = w.y - y0;
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle = dx >= 0 ? 0 : 180;
  const power = Math.round((Math.hypot(dx, dy) * 2.5) / 5) * 5;
  app.aimGuide = { x0, y0, x1: w.x, y1: w.y };
  setAim({ angle, power });
}

// ------------------------------------------------------------------ layout

function layoutStage(): void {
  const col = document.querySelector<HTMLElement>(".stage-col")!;
  // Keep the controls on screen: cap the map height to what's left of the viewport.
  const reserved = window.innerWidth <= 760 ? 300 : 250;
  const maxByHeight = ((window.innerHeight - reserved) * 16) / 9;
  col.style.maxWidth = `${Math.max(480, Math.round(maxByHeight))}px`;
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
  $("home-name").addEventListener("change", (e) => store("cc.name", (e.target as HTMLInputElement).value.trim()));
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
    const value = key === "walls" ? el.value : Number(el.value);
    app.conn?.send({ t: "settings", settings: { [key]: value } });
  });
  $("lobby-start").addEventListener("click", () => app.conn?.send({ t: "start" }));

  // Game controls
  $("ctl-angle").addEventListener("input", (e) => setAim({ angle: 180 - Number((e.target as HTMLInputElement).value) }));
  $("ctl-power").addEventListener("input", (e) => setAim({ power: Number((e.target as HTMLInputElement).value) }));
  $("ctl-weapon").addEventListener("change", (e) => setAim({ weapon: (e.target as HTMLSelectElement).value as WeaponId }));
  $("ctl-fire").addEventListener("click", fire);
  for (const btn of $$<HTMLButtonElement>("[data-step]")) {
    let repeat = 0;
    const step = (ev?: { shiftKey: boolean }) => {
      const field = btn.dataset.step as "angle" | "power";
      const delta = Number(btn.dataset.delta) * (ev?.shiftKey ? 5 : 1);
      setAim({ [field]: app.aim[field] + delta });
    };
    const stop = () => clearInterval(repeat);
    btn.addEventListener("pointerdown", (ev) => {
      step(ev);
      stop();
      const started = performance.now();
      repeat = window.setInterval(() => performance.now() - started > 350 && step(ev), 50);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) btn.addEventListener(ev, stop);
    btn.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        step(ev);
      }
    });
  }

  const canvas = renderer.canvas;
  canvas.addEventListener("pointerdown", (e) => {
    if (!isMyTurn() || app.firing) return;
    app.dragging = true;
    canvas.setPointerCapture(e.pointerId);
    aimFromPointer(e);
  });
  canvas.addEventListener("pointermove", (e) => app.dragging && aimFromPointer(e));
  for (const ev of ["pointerup", "pointercancel"]) {
    canvas.addEventListener(ev, () => {
      app.dragging = false;
      app.aimGuide = null;
    });
  }

  window.addEventListener("keydown", (e) => {
    if (app.screen !== "game" || !isMyTurn()) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const big = e.shiftKey;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => setAim({ angle: app.aim.angle + (big ? 5 : 1) }),
      ArrowRight: () => setAim({ angle: app.aim.angle - (big ? 5 : 1) }),
      ArrowUp: () => setAim({ power: app.aim.power + (big ? 50 : 10) }),
      ArrowDown: () => setAim({ power: app.aim.power - (big ? 50 : 10) }),
      PageUp: () => setAim({ power: app.aim.power + 100 }),
      PageDown: () => setAim({ power: app.aim.power - 100 }),
      Tab: () => cycleWeapon(e.shiftKey ? -1 : 1),
      " ": fire,
      Enter: fire,
    };
    const action = actions[e.key];
    if (!action) return;
    e.preventDefault();
    action();
  });

  // Shop & game over
  $("shop-grid").addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-buy], [data-sell]");
    if (!el) return;
    sfx.click();
    if (el.dataset.buy) app.conn?.send({ t: "buy", item: el.dataset.buy as ShopId, qty: 1 });
    else app.conn?.send({ t: "buy", item: el.dataset.sell as ShopId, qty: -1 });
  });
  $("shop-ready").addEventListener("click", () => app.conn?.send({ t: "ready", ready: !me()?.ready }));
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

if (import.meta.env.DEV) Object.assign(window, { __cc: { app, renderer } });
