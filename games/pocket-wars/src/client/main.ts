import { unlockAudio } from "@warrick/kit/client/audio";
import { $, $$, esc, toast } from "@warrick/kit/client/dom";
import { formatClock } from "@warrick/kit/client/format";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { ATTACK_MS, BUILD_MS, MOVE_MS_PER_TILE } from "../shared/constants";
import { MAPS, type MapDef } from "../shared/maps";
import {
  SETTING_CHOICES,
  standings,
  type ClientMsg,
  type GameState,
  type PlayerState,
  type ServerMsg,
  type TurnEvent,
} from "../shared/protocol";
import {
  forecast,
  incomeOf,
  pathTo,
  reach,
  targetsFrom,
  threatTiles,
  tileOf,
  unitById,
  unitTile,
  type Act,
  type ActEvent,
  type Board,
  type BuildEvent,
  type Reach,
  type Unit,
} from "../shared/rules";
import { TERRAIN } from "../shared/terrain";
import { MAX_HP, UNITS, UNIT_TYPES, isIndirect, type UnitType } from "../shared/units";
import { cpuNext } from "../shared/ai";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { Renderer, unitIcon, type Ghost, type Overlay } from "./render";

// ------------------------------------------------------------------ helpers

const fmt = (n: number) => n.toLocaleString("en-US");
const stars = (n: number) => (n ? "★".repeat(n) : "no cover");

// ------------------------------------------------------------------ app state

/** Server events wait here while an earlier one animates; plain states queue behind them. */
type Item =
  | { kind: "act"; ev: ActEvent; state: GameState }
  | { kind: "build"; ev: BuildEvent; state: GameState }
  | { kind: "turn"; ev: TurnEvent; state: GameState }
  | { kind: "state"; state: GameState };

interface Anim {
  item: Extract<Item, { kind: "act" | "build" }>;
  start: number;
  /** Time spent sliding along the path, then the action, in ms. */
  moveMs: number;
  actionMs: number;
  fired: boolean;
}

/** What tapping the map does next. */
type Mode =
  | { k: "idle" }
  /** One of your units is picked: its movement range is showing, and what it could attack from there. */
  | { k: "select"; unit: number; reach: Reach; danger: number[] }
  /** It has a destination, and the action menu is open. */
  | { k: "menu"; unit: number; reach: Reach; to: number; targets: Unit[]; capture: boolean }
  /** Picking what to attack; `focus` has its forecast showing. */
  | { k: "target"; unit: number; reach: Reach; to: number; targets: Unit[]; focus: number | null }
  /** Looking at someone's unit: where it could attack next turn. */
  | { k: "inspect"; unit: number; tiles: Set<number> }
  /** The action went to the server; the unit waits at its destination for the answer. */
  | { k: "sent"; unit: number; to: number; at: number };

const app = {
  queue: [] as Item[],
  anim: null as Anim | null,
  mode: { k: "idle" } as Mode,
  /** The tile the info bar describes: under the mouse, or the last one tapped. */
  focus: -1,
  hover: -1,
  camKey: "",
  endConfirmUntil: 0,
  bannerUntil: 0,
  turnKey: "",
  hideResults: false,
  buildAt: -1,
};

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "pocket-wars",
  title: "Pocket Wars",
  prefix: "pw",
  logo: "POCKET<br />WARS",
  tagline: "Turn-based tactics for 2–4 friends.<br />No accounts — just share a code.",
  placeholder: "Commander",
  footer: "A love letter to <em>Advance Wars</em> (2001).",
  playersLabel: "Armies",
  maxPlayers: 4,
  rules: [
    "Every building you own pays 1,000 a turn. Build units at your factories.",
    "Move each unit once a turn, then attack, capture or wait.",
    "Capture an enemy HQ, or wipe out an army, to knock it out.",
    "The last army standing wins. Games run long, so anyone can resign.",
  ],
  settings: {
    map: {
      label: "Map",
      fmt: (v: string) => (v === "auto" ? "Auto: one for the player count" : `${MAPS[v]?.name ?? v} (${MAPS[v]?.players ?? "?"} players)`),
    },
    turnSeconds: { label: "Turn timer", fmt: (v: number) => (v ? `${v} seconds` : "No limit") },
    fastCpus: { label: "CPU moves", fmt: (v: boolean) => (v ? "Fast" : "One at a time") },
  },
  choices: SETTING_CHOICES,
  intercept,
  onWelcome: () => {
    app.queue = [];
    app.anim = null;
    app.mode = { k: "idle" };
    renderer.clearEffects();
  },
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s): string | null =>
    s.phase === "playing" && mine(s) && mine(s)!.outDay === null
      ? "Leave this game? Your army stays on the map, and the host can hand it to a CPU. Come back with the same link."
      : null,
});
const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));

const mine = (s = shell.state): PlayerState | undefined => s?.players.find((p) => p.id === shell.me);
const mySeat = (s = shell.state) => mine(s)?.seat ?? -1;
const mapOf = (s = shell.state): MapDef | null => (s?.mapId ? MAPS[s.mapId] ?? null : null);
const boardOf = (s = shell.state): Board | null => s?.board ?? null;
const seatPlayer = (seat: number, s = shell.state) => s?.players.find((p) => p.id === s.order[seat]);
const colors = (s = shell.state): string[] => (s?.order ?? []).map((id) => s!.players.find((p) => p.id === id)?.color ?? "#ccc");
const busy = () => !!app.anim || app.queue.length > 0;

/** It's my turn and I can act: no animation playing, nothing waiting on the server. */
function canAct(s = shell.state): boolean {
  const p = mine(s);
  return (
    !!s &&
    s.phase === "playing" &&
    !s.winnerId &&
    !!p &&
    p.seat >= 0 &&
    p.outDay === null &&
    !p.cpu &&
    s.order[s.turn] === p.id &&
    !busy() &&
    app.mode.k !== "sent"
  );
}

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "game") layoutStage();
  if (screen === "home") attract.resize();
}

/** Left the game, or lost it for good. */
function onReset(): void {
  app.queue = [];
  app.anim = null;
  app.mode = { k: "idle" };
  app.camKey = "";
  $("build").hidden = true;
  $("gameover").hidden = true;
}

// ------------------------------------------------------------------ messages

function intercept(msg: ServerMsg): boolean {
  if (msg.t === "act" || msg.t === "build" || msg.t === "turn") {
    app.queue.push({ kind: msg.t, ev: msg.ev, state: msg.state } as Item);
    pump();
    return true;
  }
  if (msg.t === "state" && busy()) {
    app.queue.push({ kind: "state", state: msg.state });
    return true;
  }
  return false;
}

function onMessage(msg: ServerMsg): void {
  if (msg.t === "error" && app.mode.k === "sent") {
    // The shell has shown the message; put the unit back.
    app.mode = { k: "idle" };
    renderGame();
  }
}

function onState(s: GameState, prev: GameState | null): void {
  const m = mapOf(s);
  if (m) {
    const key = `${s.code}:${s.mapId}:${s.order.join(",")}`;
    if (key !== app.camKey) {
      app.camKey = key;
      app.mode = { k: "idle" };
      layoutStage();
      initCamera(s, m);
    }
  }
  validateMode(s);
  if (s.phase === "playing" && prev?.phase !== "playing") app.hideResults = false;
  if (s.phase !== "lobby") renderGame();
}

/** Drop a selection the new state has made stale. */
function validateMode(s: GameState): void {
  const mode = app.mode;
  if (mode.k === "idle") return;
  const b = boardOf(s);
  const u = b ? unitById(b, mode.unit) : undefined;
  if (mode.k === "inspect") {
    if (!u) app.mode = { k: "idle" };
    return;
  }
  if (mode.k === "sent") {
    if (!u || u.done || performance.now() - mode.at > 8000) app.mode = { k: "idle" };
    return;
  }
  if (!u || u.done || !canAct(s)) app.mode = { k: "idle" };
}

// ------------------------------------------------------------------ events and animation

function pump(): void {
  while (!app.anim && app.queue.length) {
    const item = app.queue.shift()!;
    if (item.kind === "state") {
      shell.applyState(item.state);
    } else if (item.kind === "turn") {
      shell.applyState(item.state);
      turnStarted(item.ev, item.state);
    } else {
      startAnim(item);
    }
  }
}

function startAnim(item: Anim["item"]): void {
  const s = shell.state;
  const m = mapOf(s);
  if (!s || !m || !s.board || document.hidden) {
    shell.applyState(item.state);
    return;
  }
  // Catch up when events pile up (Fast CPUs, a reconnect).
  const speed = app.queue.length >= 2 ? 0.3 : app.queue.length === 1 ? 0.6 : 1;
  let moveMs = 0;
  let actionMs = BUILD_MS * speed;
  if (item.kind === "act") {
    const own = item.ev.seat === mySeat(s);
    moveMs = own ? 0 : (item.ev.path.length - 1) * MOVE_MS_PER_TILE * speed;
    actionMs = (item.ev.action === "attack" ? ATTACK_MS : item.ev.action === "capture" ? 700 : 120) * speed;
  }
  const a: Anim = { item, start: performance.now(), moveMs, actionMs, fired: false };
  app.anim = a;
  if (item.kind === "act" && moveMs > 0) sfx.step();
  // Timers, not animation frames, move the queue on: frames stop in background tabs.
  window.setTimeout(() => {
    if (app.anim !== a) return;
    a.fired = true;
    fireEffects(a, m);
  }, moveMs);
  window.setTimeout(() => finishAnim(a), moveMs + actionMs);
}

function finishAnim(a: Anim): void {
  if (app.anim !== a) return;
  app.anim = null;
  shell.applyState(a.item.state);
  pump();
}

function fireEffects(a: Anim, m: MapDef): void {
  const item = a.item;
  if (item.kind === "build") {
    sfx.build();
    return;
  }
  const ev = item.ev;
  const end = ev.path[ev.path.length - 1];
  if (ev.action === "attack") {
    const before = shell.state?.board;
    const target = before ? unitById(before, ev.target!) : undefined;
    const tTile = target ? unitTile(m, target) : end;
    const heavy = ev.type === "heavy" || ev.type === "artillery" || ev.type === "tank";
    sfx.shot(heavy);
    renderer.flash(m, tTile);
    renderer.float(m, tTile, `-${ev.dealt}`, "#ff8a8a");
    if (ev.killed) {
      renderer.boom(m, tTile, 180);
      setTimeout(() => sfx.boom(), 180);
    }
    if (ev.taken) {
      const d = a.actionMs * 0.4;
      setTimeout(() => sfx.shot(ev.targetType === "heavy" || ev.targetType === "tank"), d);
      renderer.flash(m, end, d);
      renderer.float(m, end, `-${ev.taken}`, "#ff8a8a", d);
      if (ev.lost) {
        renderer.boom(m, end, d + 180);
        setTimeout(() => sfx.boom(), d + 180);
      }
    }
  } else if (ev.action === "capture") {
    sfx.capture(!!ev.captured);
    renderer.float(m, end, ev.captured ? "Captured!" : `${ev.left} left`, ev.captured ? "#ffd23f" : "#fff");
  }
}

/** The ghost of the unit being animated (or waiting for the server), and the unit it stands in for. */
function ghosts(m: MapDef, b: Board, now: number): { hide: Set<number>; ghosts: Ghost[] } {
  const hide = new Set<number>();
  const out: Ghost[] = [];
  const a = app.anim;
  const mode = app.mode;
  if (a?.item.kind === "act") {
    const ev = a.item.ev;
    const u = unitById(b, ev.unit);
    if (u) {
      hide.add(u.id);
      const path = ev.path;
      const t = a.moveMs > 0 ? Math.min(1, (now - a.start) / a.moveMs) : 1;
      const f = t * (path.length - 1);
      const i = Math.min(path.length - 2, Math.floor(f));
      const p0 = path[Math.max(0, i)];
      const p1 = path[Math.min(path.length - 1, i + 1)];
      const k = path.length > 1 ? f - i : 0;
      const x = (p0 % m.w) * (1 - k) + (p1 % m.w) * k;
      const y = Math.floor(p0 / m.w) * (1 - k) + Math.floor(p1 / m.w) * k;
      const hp = a.fired && ev.taken ? Math.max(1, u.hp - ev.taken) : u.hp;
      out.push({ unit: { ...u, hp, done: false }, x, y, alpha: a.fired && ev.lost ? 0.35 : 1 });
    }
  } else if (a?.item.kind === "build") {
    const u = a.item.ev.unit;
    const t = Math.min(1, (now - a.start) / Math.max(1, a.actionMs));
    out.push({ unit: u, x: u.x, y: u.y, scale: 0.3 + 0.7 * t, alpha: 0.4 + 0.6 * t });
  } else if (mode.k === "menu" || mode.k === "target" || mode.k === "sent") {
    const u = unitById(b, mode.unit);
    if (u) {
      hide.add(u.id);
      out.push({ unit: u, x: mode.to % m.w, y: Math.floor(mode.to / m.w) });
    }
  }
  return { hide, ghosts: out };
}

function turnStarted(ev: TurnEvent, s: GameState): void {
  const m = mapOf(s);
  const p = seatPlayer(ev.seat, s);
  if (!m || !p) return;
  for (const r of ev.repairs) {
    const u = s.board ? unitById(s.board, r.unit) : undefined;
    if (u) renderer.float(m, unitTile(m, u), "+HP", "#7dff8a");
  }
  if (ev.out) return;
  if (p.id === shell.me) {
    sfx.turn();
    flashBanner(`<span class="big">YOUR TURN</span>Day ${ev.day} · +${fmt(ev.income)} funds${ev.repairCost ? ` · repairs −${fmt(ev.repairCost)}` : ""}`, 1800);
  } else {
    flashBanner(`<span class="big" style="color:${p.color}">${esc(p.name)}</span>Day ${ev.day}`, 1100);
  }
}

// ------------------------------------------------------------------ frame loop

/** What the canvas was last drawn from: the state, the mode (and its target), the tile under the mouse. */
let drawnFrom: unknown[] = [];

/**
 * The canvas is drawn again only when what it shows changes, or while something on it moves: a
 * unit sliding or being built, effects, the pulsing selection and targets. Otherwise a frame
 * just keeps the clock up to date.
 */
function frame(now: number): void {
  requestAnimationFrame(frame);
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game") return;
  const s = shell.state;
  const m = mapOf(s);
  const b = boardOf(s);
  if (s && m && b) {
    const mode = app.mode;
    const from = [s, mode, mode.k === "target" ? mode.focus : null, app.hover];
    const o = overlay(m, b);
    const moving = !!app.anim || renderer.busy || o.selected !== undefined || !!o.targets?.length;
    if (moving || renderer.stale || from.some((v, i) => v !== drawnFrom[i])) {
      drawnFrom = from;
      const g = ghosts(m, b, now);
      renderer.draw({ m, b, colors: colors(s), activeSeat: s.turn, hide: g.hide, ghosts: g.ghosts, overlay: o }, now);
    }
  }
  tickClocks(now);
}

function overlay(m: MapDef, b: Board): Overlay {
  const mode = app.mode;
  const o: Overlay = { cursor: app.hover };
  if (mode.k === "select") {
    o.move = mode.reach.ends;
    o.danger = mode.danger;
    o.selected = mode.reach.origin;
    if (app.hover >= 0 && mode.reach.ends.includes(app.hover)) o.path = pathTo(mode.reach, app.hover);
  } else if (mode.k === "menu") {
    o.path = pathTo(mode.reach, mode.to);
    o.selected = mode.to;
    o.targets = mode.targets.map((t) => ({ tile: unitTile(m, t) }));
  } else if (mode.k === "target") {
    const u = unitById(b, mode.unit);
    o.selected = mode.to;
    o.targets = mode.targets.map((t) => ({
      tile: unitTile(m, t),
      label: u ? `-${forecast(m, { ...u, x: mode.to % m.w, y: Math.floor(mode.to / m.w) }, mode.to, t).dealt}` : undefined,
      focus: t.id === mode.focus,
    }));
  } else if (mode.k === "inspect") {
    o.danger = mode.tiles;
    const u = unitById(b, mode.unit);
    if (u) o.selected = unitTile(m, u);
  }
  return o;
}

/** Enemy tiles a unit could attack this turn, from anywhere it can stop. */
function reachableTargets(m: MapDef, b: Board, u: Unit, r: Reach): number[] {
  const out = new Set<number>();
  for (const to of isIndirect(u.type) ? [r.origin] : r.ends) {
    for (const t of targetsFrom(m, b, { ...u, x: to % m.w, y: Math.floor(to / m.w) }, to)) out.add(unitTile(m, t));
  }
  return [...out];
}

function tickClocks(now: number): void {
  const s = shell.state;
  if (!s) return;
  const clock = document.querySelector<HTMLElement>("#hud-turn .clock");
  if (clock) {
    const left = s.turnDeadline && s.phase === "playing" && !s.winnerId ? Math.max(0, s.turnDeadline - shell.serverNow()) : null;
    const text = left === null ? "" : formatClock(left);
    if (clock.textContent !== text) clock.textContent = text;
    clock.classList.toggle("low", left !== null && left < 15000);
  }
  if (app.bannerUntil && now > app.bannerUntil) {
    app.bannerUntil = 0;
    renderBanner();
  }
  if (app.endConfirmUntil && now > app.endConfirmUntil) {
    app.endConfirmUntil = 0;
    renderHud();
  }
}

// ------------------------------------------------------------------ the map: taps

function tap(t: number): void {
  const s = shell.state;
  const m = mapOf(s);
  const b = boardOf(s);
  if (!s || !m || !b || t < 0) return;
  unlockAudio();
  app.focus = t;
  const mode = app.mode;
  const u = b.units.find((x) => unitTile(m, x) === t);
  const seat = mySeat(s);
  const act = canAct(s);

  if (mode.k === "sent") return;
  if (mode.k === "menu") {
    // Tapping the map with the menu open takes the move back.
    backToSelect(mode.unit);
    sfx.cancel();
    return;
  }
  if (mode.k === "target") {
    const target = mode.targets.find((x) => unitTile(m, x) === t);
    if (target) {
      if (mode.focus === target.id) return confirmAttack();
      mode.focus = target.id;
      sfx.select();
      renderGame();
      return;
    }
    openMenu(mode.unit, mode.to);
    return;
  }
  if (mode.k === "select") {
    if (mode.reach.ends.includes(t) && act) {
      sfx.step();
      openMenu(mode.unit, t);
      return;
    }
    if (u && u.seat === seat && !u.done && act) {
      select(u);
      return;
    }
    app.mode = { k: "idle" };
    if (!u) {
      sfx.cancel();
      renderGame();
      return;
    }
  }
  // Nothing picked.
  if (u && act && u.seat === seat && !u.done) return select(u);
  const bi = m.buildingAt[t];
  if (!u && act && bi >= 0 && m.buildings[bi].kind === "factory" && b.owners[bi] === seat) return openBuild(t);
  if (u) {
    if (app.mode.k === "inspect" && app.mode.unit === u.id) app.mode = { k: "idle" };
    else app.mode = { k: "inspect", unit: u.id, tiles: threatTiles(m, b, u) };
    sfx.select();
  } else {
    app.mode = { k: "idle" };
  }
  renderGame();
}

function select(u: Unit): void {
  const m = mapOf()!;
  const b = boardOf()!;
  app.mode = selecting(m, b, u);
  app.focus = unitTile(m, u);
  sfx.select();
  renderGame();
}

function backToSelect(unitId: number): void {
  const m = mapOf();
  const b = boardOf();
  const u = b ? unitById(b, unitId) : undefined;
  if (!m || !b || !u || !canAct()) {
    app.mode = { k: "idle" };
  } else {
    app.mode = selecting(m, b, u);
  }
  renderGame();
}

/** Pick a unit: where it can move, and the enemies it could attack after moving (worked out once, not every frame). */
function selecting(m: MapDef, b: Board, u: Unit): Mode {
  const r = reach(m, b, u);
  return { k: "select", unit: u.id, reach: r, danger: reachableTargets(m, b, u, r) };
}

function openMenu(unitId: number, to: number): void {
  const m = mapOf()!;
  const b = boardOf()!;
  const u = unitById(b, unitId);
  if (!u) return;
  const r = reach(m, b, u);
  // Artillery can only fire from where it started; targetsFrom knows.
  const targets = targetsFrom(m, b, u, to);
  const bi = m.buildingAt[to];
  const capture = UNITS[u.type].captures && bi >= 0 && b.owners[bi] !== u.seat;
  app.mode = { k: "menu", unit: u.id, reach: r, to, targets, capture };
  app.focus = to;
  renderGame();
}

function startTargeting(): void {
  const mode = app.mode;
  if (mode.k !== "menu" || !mode.targets.length) return;
  app.mode = { k: "target", unit: mode.unit, reach: mode.reach, to: mode.to, targets: mode.targets, focus: mode.targets.length === 1 ? mode.targets[0].id : null };
  sfx.select();
  renderGame();
}

function confirmAttack(): void {
  const mode = app.mode;
  if (mode.k !== "target" || mode.focus === null) return;
  send({ unit: mode.unit, to: mode.to, action: "attack", target: mode.focus });
}

function send(act: Act): void {
  const mode = app.mode;
  if (mode.k !== "menu" && mode.k !== "target") return;
  if (!shell.send({ t: "act", ...act })) {
    toast("Not connected — reconnecting, try again in a moment");
    return;
  }
  app.mode = { k: "sent", unit: act.unit, to: act.to, at: performance.now() };
  renderGame();
}

/** Esc, or the Cancel button: one step back. */
function back(): void {
  const mode = app.mode;
  if (!$("build").hidden) return closeBuild();
  if (mode.k === "target") openMenu(mode.unit, mode.to);
  else if (mode.k === "menu") backToSelect(mode.unit);
  else if (mode.k !== "sent") app.mode = { k: "idle" };
  sfx.cancel();
  renderGame();
}

// ------------------------------------------------------------------ menus

function renderMenu(): void {
  const menu = $("action-menu");
  const fc = $("forecast");
  const mode = app.mode;
  const m = mapOf();
  const b = boardOf();
  menu.hidden = mode.k !== "menu";
  fc.hidden = mode.k !== "target";
  if (!m || !b) return;
  if (mode.k === "menu") {
    const u = unitById(b, mode.unit)!;
    const bi = m.buildingAt[mode.to];
    const items: string[] = [];
    if (mode.targets.length) items.push(`<button class="act act-attack" data-act="attack">Attack</button>`);
    if (mode.capture) {
      const left = b.capture[bi];
      const after = Math.max(0, left - u.hp);
      items.push(`<button class="act act-capture" data-act="capture">Capture <span>${left}→${after}</span></button>`);
    }
    items.push(`<button class="act" data-act="wait">Wait</button>`);
    items.push(`<button class="act act-cancel" data-act="cancel">Cancel</button>`);
    let note = "";
    if (isIndirect(u.type) && mode.to !== mode.reach.origin) note = `<p class="act-note">Artillery can't fire after moving.</p>`;
    menu.innerHTML = items.join("") + note;
    place(menu, m, mode.to, mode.targets.map((t) => unitTile(m, t)));
  } else if (mode.k === "target") {
    const u = unitById(b, mode.unit)!;
    const target = mode.targets.find((t) => t.id === mode.focus);
    if (!target) {
      fc.innerHTML = `<p>Tap a red target to see the damage.</p><div class="fc-row"><button class="btn btn-small" data-fc="back">Back</button></div>`;
      place(fc, m, mode.to, mode.targets.map((t) => unitTile(m, t)));
      return;
    }
    const s = shell.state!;
    const moved = { ...u, x: mode.to % m.w, y: Math.floor(mode.to / m.w) };
    const f = forecast(m, moved, mode.to, target);
    const them = seatPlayer(target.seat, s);
    fc.innerHTML = `
      <div class="fc-side"><span class="chip" style="background:${seatPlayer(u.seat, s)?.color}"></span>${UNITS[u.type].name} <b>${u.hp}</b> HP
        <span class="fc-dmg">deals <b>${f.dealt}</b></span></div>
      <div class="fc-side"><span class="chip" style="background:${them?.color}"></span>${UNITS[target.type].name} <b>${target.hp}</b> HP
        <span class="fc-dmg">${f.kills ? "<b>destroyed</b>" : f.counter ? `hits back <b>${f.taken}</b>${f.dies ? " — yours is destroyed" : ""}` : "can't hit back"}</span></div>
      <div class="fc-row"><button class="btn btn-small" data-fc="back">Back</button><button class="btn btn-small btn-primary" data-fc="fire">Attack</button></div>`;
    place(fc, m, unitTile(m, target), [mode.to, ...mode.targets.map((t) => unitTile(m, t))]);
  }
}

/** Put a floating menu beside a tile, inside the stage, covering as few of `avoid` as it can. */
function place(el: HTMLElement, m: MapDef, tile: number, avoid: number[] = []): void {
  const stage = $("stage");
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const r = renderer.tileRect(m, tile);
  const w = el.offsetWidth || 160;
  const h = el.offsetHeight || 120;
  const gap = 8;
  const cx = r.x + r.size / 2;
  const cy = r.y + r.size / 2;
  const spots = [
    { x: r.x + r.size + gap, y: cy - h / 2 },
    { x: r.x - w - gap, y: cy - h / 2 },
    { x: cx - w / 2, y: r.y + r.size + gap },
    { x: cx - w / 2, y: r.y - h - gap },
  ].map((p) => ({ x: Math.max(6, Math.min(W - w - 6, p.x)), y: Math.max(6, Math.min(H - h - 6, p.y)) }));
  const boxes = [tile, ...avoid].map((t) => renderer.tileRect(m, t));
  const covered = (p: { x: number; y: number }) =>
    boxes.filter((b) => p.x < b.x + b.size && b.x < p.x + w && p.y < b.y + b.size && b.y < p.y + h).length;
  const best = spots.reduce((a, c) => (covered(c) < covered(a) ? c : a));
  el.style.left = `${Math.round(best.x)}px`;
  el.style.top = `${Math.round(best.y)}px`;
}

function openBuild(at: number): void {
  const s = shell.state;
  const p = mine(s);
  if (!s || !p || !s.board) return;
  app.buildAt = at;
  app.mode = { k: "idle" };
  const funds = s.board.funds[p.seat];
  $("build-funds").textContent = fmt(funds);
  const list = $("build-list");
  list.innerHTML = "";
  for (const type of UNIT_TYPES) {
    const d = UNITS[type];
    const btn = document.createElement("button");
    btn.className = "build-item";
    btn.dataset.unit = type;
    btn.disabled = d.cost > funds;
    btn.innerHTML = `<span class="bi-icon"></span>
      <span class="bi-text"><b>${d.name}</b><span class="muted">${esc(d.blurb)}</span>
      <span class="bi-stats">Move ${d.move} · Range ${d.minRange === d.maxRange ? d.maxRange : `${d.minRange}–${d.maxRange}`}${d.captures ? " · Captures" : ""}</span></span>
      <span class="bi-cost">${fmt(d.cost)}</span>`;
    btn.querySelector(".bi-icon")!.appendChild(unitIcon(type, p.color, 40));
    if (d.cost > funds) btn.title = `Needs ${fmt(d.cost - funds)} more`;
    list.appendChild(btn);
  }
  $("build").hidden = false;
  sfx.select();
  list.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

function closeBuild(): void {
  $("build").hidden = true;
  app.buildAt = -1;
}

function build(type: UnitType): void {
  if (app.buildAt < 0 || !canAct()) return closeBuild();
  if (!shell.send({ t: "build", at: app.buildAt, unit: type })) toast("Not connected — reconnecting, try again in a moment");
  closeBuild();
}

// ------------------------------------------------------------------ rendering the rest

function renderGame(): void {
  const s = shell.state;
  if (!s || s.phase === "lobby") return;
  renderHud();
  renderPlayers(s);
  renderInfo();
  renderMenu();
  renderBanner();
  renderGameOver(s);
  if (s.phase !== "playing" || !canAct(s)) {
    if (!$("build").hidden) closeBuild();
  }
}

function renderHud(): void {
  const s = shell.state;
  if (!s || s.phase === "lobby") return;
  const turnP = seatPlayer(s.turn, s);
  const me = mine(s);
  let who = "";
  if (s.phase === "gameover" || s.winnerId) {
    const w = s.players.find((p) => p.id === s.winnerId);
    who = w ? `<span class="chip" style="background:${w.color}"></span><span class="who">${esc(w.name)} wins!</span>` : `<span class="who">Game over</span>`;
  } else if (turnP) {
    const label = turnP.id === shell.me ? "Your turn" : `${esc(turnP.name)}'s turn${turnP.cpu ? (turnP.standIn ? " (CPU standing in)" : "") : !turnP.connected ? " (away)" : ""}`;
    who = `<span class="chip" style="background:${turnP.color}"></span><span class="who">${label}</span>`;
  }
  const html = `<span class="day">Day ${s.day || 1}</span>${who}<span class="clock"></span>`;
  const turnEl = $("hud-turn");
  if (turnEl.dataset.html !== html) {
    turnEl.innerHTML = html;
    turnEl.dataset.html = html;
  }
  const b = s.board;
  const seat = me?.seat ?? -1;
  $("hud-funds").textContent = b && seat >= 0 ? fmt(b.funds[seat]) : "—";
  $("hud-income").textContent = b && seat >= 0 && !b.out[seat] ? `+${fmt(incomeOf(b, seat))}` : "—";

  const end = $<HTMLButtonElement>("end-turn");
  if (s.phase === "gameover") {
    end.textContent = "Results";
    end.disabled = false;
    end.classList.remove("confirm");
    return;
  }
  const act = canAct(s);
  end.disabled = !act;
  const ready = b && seat >= 0 ? b.units.filter((u) => u.seat === seat && !u.done).length : 0;
  const confirming = app.endConfirmUntil > performance.now();
  end.textContent = confirming ? `End? ${ready} ready` : "End turn";
  end.classList.toggle("confirm", confirming);
  end.title = act ? (ready ? `${ready} unit${ready === 1 ? "" : "s"} haven't moved` : "") : "Not your turn";
}

function renderPlayers(s: GameState): void {
  const b = s.board;
  const host = shell.canHost(s);
  const rows = s.order
    .map((id) => s.players.find((p) => p.id === id))
    .filter((p): p is PlayerState => !!p)
    .map((p) => {
      const out = p.outDay !== null;
      const units = b ? b.units.filter((u) => u.seat === p.seat) : [];
      const blds = b ? b.owners.filter((o) => o === p.seat).length : 0;
      const tags = [
        p.id === shell.me ? `<span class="tag tag-you">you</span>` : "",
        p.cpu && !p.standIn ? `<span class="tag">CPU · ${p.cpu}</span>` : "",
        p.standIn ? `<span class="tag">CPU standing in</span>` : "",
        !p.cpu && !p.connected && !out ? `<span class="tag">away</span>` : "",
        out ? `<span class="tag">${p.resigned ? "resigned" : "out"} · day ${p.outDay}</span>` : "",
      ].join("");
      const takeover =
        host && !p.cpu && !p.connected && !out && s.phase === "playing" && !s.winnerId
          ? `<button class="btn btn-small" data-takeover="${p.id}">Hand to CPU</button>`
          : "";
      const cls = [s.order[s.turn] === p.id && s.phase === "playing" ? "turn" : "", out ? "dead" : ""].join(" ");
      const stats = out
        ? ""
        : `<span class="pstats">${b ? `${fmt(b.funds[p.seat])} · +${fmt(incomeOf(b, p.seat))}` : ""} · ${units.length} unit${units.length === 1 ? "" : "s"} · ${blds} bldg</span>`;
      return `<li class="${cls}">
        <span class="chip" style="background:${p.color}"></span>
        <span class="pname">${esc(p.name)}${tags}</span>
        ${stats}${takeover}
      </li>`;
    });
  const watchers = s.players.filter((p) => p.seat < 0);
  if (watchers.length) rows.push(`<li class="muted watching">Watching: ${watchers.map((p) => esc(p.name)).join(", ")}</li>`);
  $("game-players").innerHTML = rows.join("");
  const m = mapOf(s);
  $("map-name").textContent = m ? m.name : "";

  const fast = $("fast-toggle");
  fast.hidden = !host || s.phase !== "playing";
  $<HTMLInputElement>("fast-cpus").checked = !!s.settings.fastCpus;
  const me = mine(s);
  $("resign").hidden = !(s.phase === "playing" && me && me.seat >= 0 && me.outDay === null && !s.winnerId);
}

function renderInfo(): void {
  const s = shell.state;
  const m = mapOf(s);
  const b = boardOf(s);
  const el = $("info");
  if (!s || !m || !b) {
    el.innerHTML = "";
    return;
  }
  const mode = app.mode;
  let hint = "";
  const me = mine(s);
  if (s.phase === "gameover") hint = "Game over.";
  else if (s.winnerId) hint = "";
  else if (!me || me.seat < 0) hint = "You're watching. Tap a unit to see its range.";
  else if (me.outDay !== null) hint = "You're out. Tap a unit to see its range.";
  else if (s.order[s.turn] === me.id && !me.cpu && (busy() || mode.k === "sent")) hint = "";
  else if (!canAct(s)) hint = busy() ? "" : `Waiting for ${esc(seatPlayer(s.turn, s)?.name ?? "the next player")}. Tap a unit to see its range.`;
  else if (mode.k === "select") hint = "Tap a blue tile to move there (its own tile to stay). Red: what it can attack.";
  else if (mode.k === "menu") hint = "Pick an action, or tap the map to take the move back.";
  else if (mode.k === "target") hint = "Tap a target to see the damage, then tap it again (or Attack) to fire.";
  else hint = "Tap a unit to move it, or a free factory to build. End turn when you're done.";

  const t = mode.k === "select" ? (app.hover >= 0 ? app.hover : mode.reach.origin) : mode.k === "menu" || mode.k === "target" ? mode.to : app.hover >= 0 ? app.hover : app.focus;
  let tile = "";
  if (t >= 0) {
    const terr = m.tiles[t];
    const bi = m.buildingAt[t];
    let name = TERRAIN[terr].name;
    if (bi >= 0) {
      const owner = b.owners[bi];
      const op = owner >= 0 ? seatPlayer(owner, s) : null;
      name = `${op ? `<span class="chip" style="background:${op.color}"></span>${esc(op.name)}'s ` : "Neutral "}${TERRAIN[terr].name.toLowerCase()}`;
      if (b.capture[bi] < 20) name += ` · capture ${b.capture[bi]}/20`;
    }
    const u =
      mode.k === "menu" || mode.k === "target" ? unitById(b, mode.unit) : b.units.find((x) => unitTile(m, x) === t);
    let unit = "";
    if (u) {
      const d = UNITS[u.type];
      const op = seatPlayer(u.seat, s);
      unit = `<span class="info-unit"><span class="chip" style="background:${op?.color}"></span><b>${d.name}</b> ${u.hp}/${MAX_HP} HP · move ${d.move} · range ${d.minRange === d.maxRange ? d.maxRange : `${d.minRange}–${d.maxRange}`}${u.seat === s.turn ? (u.done ? " · done" : " · ready") : ""}</span>`;
    }
    tile = `<span class="info-tile">${name} <span class="stars" title="Defence">${stars(TERRAIN[terr].defense)}</span></span>${unit}`;
  }
  const html = `<div class="info-row">${tile}</div>${hint ? `<div class="hint">${hint}</div>` : ""}`;
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
}

function flashBanner(html: string, ms: number): void {
  app.bannerUntil = performance.now() + ms;
  const el = $("banner");
  el.innerHTML = html;
  el.classList.add("flash");
  el.hidden = false;
}

function renderBanner(): void {
  const s = shell.state;
  const el = $("banner");
  if (!s) return;
  if (s.phase === "playing" && s.winnerId && !busy()) {
    const w = s.players.find((p) => p.id === s.winnerId);
    el.classList.remove("flash");
    el.innerHTML = `<span class="big" style="color:${w?.color}">${esc(w?.name ?? "")} wins!</span>Day ${s.day}`;
    el.hidden = false;
    return;
  }
  if (app.bannerUntil) return;
  el.hidden = true;
}

let wonSound = "";

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover" && !app.hideResults;
  $("gameover").hidden = !open;
  if (s.phase !== "gameover") return;
  const key = `${s.code}:${s.winnerId}:${s.turnNo}`;
  if (wonSound !== key) {
    wonSound = key;
    sfx.win();
  }
  const ranked = standings(s);
  const best = ranked[0];
  $("gameover-title").textContent = best?.id === shell.me ? "Victory!" : "Game over";
  $("gameover-winner").innerHTML = best ? `<b style="color:${best.color}">${esc(best.name)}</b> holds the field on day ${s.day}.` : "";
  $("gameover-rows").innerHTML = ranked
    .map((p, i) => {
      const result = p.id === s.winnerId ? "Winner" : p.outDay !== null ? `${p.resigned ? "Resigned" : "Out"} day ${p.outDay}` : "—";
      return `<tr class="${p.id === s.winnerId ? "winner" : ""}">
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${p.color}"></span>${esc(p.name)}</span></td>
        <td>${result}</td><td>${p.stats.built}</td><td>${p.stats.kills}</td><td>${p.stats.lost}</td><td>${p.stats.captured}</td></tr>`;
    })
    .join("");
  const back = $<HTMLButtonElement>("gameover-lobby");
  const host = shell.canHost(s);
  back.disabled = !host;
  back.textContent = host ? "Back to lobby" : `Waiting for ${s.players.find((p) => p.id === s.hostId)?.name ?? "the host"}…`;
}

// ------------------------------------------------------------------ camera and layout

function initCamera(s: GameState, m: MapDef): void {
  renderer.fit(m);
  const seat = mySeat(s);
  // On a phone the whole map is small; start zoomed in on your HQ.
  if (renderer.scale < 26 && seat >= 0) {
    const hq = m.buildings[m.hq[seat]];
    renderer.centerOn(m, tileOf(m, hq.x, hq.y), 30);
  }
}

function layoutStage(): void {
  const stage = $("stage");
  renderer.resize(stage.clientWidth, stage.clientHeight);
  const m = mapOf();
  if (m) renderer.clamp(m);
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  window.addEventListener("resize", () => (shell.screen === "home" ? attract.resize() : layoutStage()));
  new ResizeObserver(() => {
    if (shell.screen !== "game") return;
    const stage = $("stage");
    const m = mapOf();
    const wasFit = m ? Math.abs(renderer.scale - renderer.fitScale(m)) < 0.5 : false;
    renderer.resize(stage.clientWidth, stage.clientHeight);
    if (m) {
      if (wasFit) renderer.fit(m);
      else renderer.clamp(m);
    }
  }).observe($("stage"));

  // Pan with a drag, pinch to zoom, tap to act.
  const canvas = renderer.canvas;
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; moved: boolean } | null = null;
  let pinch: { d: number; cx: number; cy: number } | null = null;
  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) drag = { ...local(e), moved: false };
    if (pointers.size === 2) {
      const [a, c] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - c.x, a.y - c.y), cx: (a.x + c.x) / 2, cy: (a.y + c.y) / 2 };
      if (drag) drag.moved = true;
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const m = mapOf();
    const p = local(e);
    if (e.pointerType === "mouse" && m && !pointers.size) {
      const t = renderer.tileAt(m, e.clientX, e.clientY);
      if (t !== app.hover) {
        app.hover = t;
        renderInfo();
      }
    }
    if (!pointers.has(e.pointerId) || !m) return;
    const prev = pointers.get(e.pointerId)!;
    pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const [a, c] = [...pointers.values()];
      const d = Math.hypot(a.x - c.x, a.y - c.y);
      const cx = (a.x + c.x) / 2;
      const cy = (a.y + c.y) / 2;
      renderer.zoom(m, d / Math.max(1, pinch.d), cx, cy);
      renderer.pan(m, cx - pinch.cx, cy - pinch.cy);
      pinch = { d, cx, cy };
      renderMenu();
      return;
    }
    if (drag) {
      if (!drag.moved && Math.hypot(p.x - drag.x, p.y - drag.y) > 7) drag.moved = true;
      if (drag.moved) {
        renderer.pan(m, p.x - prev.x, p.y - prev.y);
        renderMenu();
      }
    }
  });
  const up = (e: PointerEvent) => {
    const m = mapOf();
    const wasTap = drag && !drag.moved && pointers.size === 1 && e.type === "pointerup";
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) {
      drag = null;
      if (wasTap && m) tap(renderer.tileAt(m, e.clientX, e.clientY));
    }
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && app.hover !== -1) {
      app.hover = -1;
      renderInfo();
    }
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      const m = mapOf();
      if (!m) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      renderer.zoom(m, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      renderMenu();
    },
    { passive: false },
  );
  for (const b of $$<HTMLButtonElement>("[data-zoom]")) {
    b.addEventListener("click", () => {
      const m = mapOf();
      if (!m) return;
      const z = b.dataset.zoom;
      if (z === "fit") renderer.fit(m);
      else renderer.zoom(m, z === "in" ? 1.35 : 1 / 1.35);
      renderMenu();
      b.blur();
    });
  }

  // Menus.
  $("action-menu").addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    const mode = app.mode;
    if (!a || mode.k !== "menu") return;
    if (a === "attack") startTargeting();
    else if (a === "capture") send({ unit: mode.unit, to: mode.to, action: "capture" });
    else if (a === "wait") send({ unit: mode.unit, to: mode.to, action: "wait" });
    else back();
  });
  $("forecast").addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-fc]")?.dataset.fc;
    if (a === "fire") confirmAttack();
    else if (a === "back") back();
  });
  $("build-list").addEventListener("click", (e) => {
    const type = (e.target as HTMLElement).closest<HTMLElement>("[data-unit]")?.dataset.unit as UnitType | undefined;
    if (type) build(type);
  });
  $("build-close").addEventListener("click", closeBuild);
  $("build").addEventListener("click", (e) => {
    if (e.target === $("build")) closeBuild();
  });

  $("end-turn").addEventListener("click", () => {
    const s = shell.state;
    const btn = $("end-turn");
    btn.blur();
    if (s?.phase === "gameover") {
      app.hideResults = false;
      renderGame();
      return;
    }
    if (!canAct(s)) return;
    const seat = mySeat(s);
    const ready = s!.board!.units.filter((u) => u.seat === seat && !u.done).length;
    if (ready && app.endConfirmUntil < performance.now()) {
      app.endConfirmUntil = performance.now() + 3000;
      renderHud();
      return;
    }
    app.endConfirmUntil = 0;
    app.mode = { k: "idle" };
    shell.send({ t: "end" });
    renderGame();
  });
  $("gameover-map").addEventListener("click", () => {
    app.hideResults = true;
    renderGame();
  });
  $("resign").addEventListener("click", () => {
    if (!confirm("Resign? Your army leaves the map and your buildings turn neutral. There's no undo.")) return;
    shell.send({ t: "resign" });
  });
  $("fast-cpus").addEventListener("change", (e) => {
    shell.send({ t: "fast", on: (e.target as HTMLInputElement).checked });
    (e.target as HTMLElement).blur();
  });
  $("game-players").addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-takeover]")?.dataset.takeover;
    if (id) shell.send({ t: "takeover", id });
  });

  window.addEventListener("keydown", (e) => {
    if (shell.screen !== "game") return;
    const target = e.target as HTMLElement;
    if (target.closest("input, select, textarea")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      back();
    }
  });
  document.addEventListener("visibilitychange", () => {
    // Coming back to a hidden tab: skip whatever piled up.
    if (document.visibilityState === "visible" && app.anim) finishAnim(app.anim);
  });
}

wire();
shell.start();
requestAnimationFrame(frame);
// Labels drawn before the pixel font arrived were drawn in the fallback font.
document.fonts?.addEventListener("loadingdone", () => (renderer.stale = true));

// Dev aid: the console can drive a seat with the CPU (`__pw.autoplay("hard")`) to play whole games.
if (import.meta.env.DEV) {
  let auto: string | null = null;
  const autoStep = () => {
    const s = shell.state;
    const m = mapOf(s);
    if (!auto || !s || !m || !s.board || !canAct(s)) return;
    const mv = cpuNext(auto as "easy", m, s.board, mySeat(s), Math.random, s.day);
    if (mv.kind === "act") shell.send({ t: "act", ...mv.act });
    else if (mv.kind === "build") shell.send({ t: "build", at: mv.at, unit: mv.unit });
    else shell.send({ t: "end" });
    app.mode = { k: "sent", unit: mv.kind === "act" ? mv.act.unit : -1, to: mv.kind === "act" ? mv.act.to : -1, at: performance.now() };
  };
  setInterval(autoStep, 250);
  /** Skip animations (a hidden pane throttles their timers), then take one autoplay step. */
  const tick = () => {
    while (app.anim) finishAnim(app.anim);
    autoStep();
  };
  Object.assign(window, { __pw: { app, renderer, shell, tick, autoplay: (level: string | null) => (auto = level) } });
}
