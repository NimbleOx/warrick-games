import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import { $, $$, esc, toast } from "@warrick/kit/client/dom";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { applyFrame, Battle, planned, type BattleEvent, type Cmd, type Frame, type Group, type Snapshot } from "../shared/battle";
import {
  MAX_LEVEL,
  PLAYER_COLORS,
  SEND_PCTS,
  TICKS_PER_SEC,
  TICK_MS,
  TURN_TICKS,
  UPGRADE_COST,
  type SendPct,
} from "../shared/constants";
import { BASES_PER_PLAYER, type MapSize } from "../shared/map";
import {
  SETTING_CHOICES,
  type ClientMsg,
  type GameState,
  type Mode,
  type PlayerState,
  type ServerMsg,
  type Settings,
  type TurnState,
} from "../shared/protocol";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { Controls } from "./input";
import { fitMap, Renderer, type Look, type Scene } from "./render";

// ------------------------------------------------------------------ helpers

function clock(ticks: number): string {
  const secs = Math.max(0, Math.ceil(ticks / TICKS_PER_SEC));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const NO_PLAN: Cmd[] = [];

// ------------------------------------------------------------------ app state

interface FeedItem {
  html: string;
  at: number;
}

const app = {
  /** Our copy of the battle, kept in step by the server's frames. */
  battle: null as Battle | null,
  /** Slot → how it looks. Kept from the last state seen in play, so the final map keeps its colours. */
  looks: Array<Look | null>(MAX_PLAYERS).fill(null),
  mySlot: -1,
  /** When the last frame arrived (performance.now), for gliding units between frames. */
  frameAt: 0,
  resyncing: false,
  feed: [] as FeedItem[],
  bannerKey: "",
  sounded: "",
  stageWidth: 0,
  pct: 50 as SendPct,
  /** Turns: my plan, as the server last sent it, and the turn it's for. */
  plan: NO_PLAN,
  planN: 0,
  /** Turns: the last turn whose plan we've seen start, and when (performance.now). */
  planSeen: 0,
  planAt: 0,
  /** Turns: when I was knocked out (performance.now), for the banner. */
  outAt: 0,
  /** Turns: the last countdown second beeped. */
  beeped: "",
};

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "base-jump",
  title: "Base Jump",
  prefix: "bj",
  logo: "BASE<br />JUMP",
  tagline: "Take every base. Tanks need roads,<br />helicopters don't. No accounts — just share a code.",
  placeholder: "Commander",
  footer: "Bases build units. Send them out to take more bases. Take them all.",
  playersLabel: "Commanders",
  rules: [
    "Every base you hold builds units. Drag from yours to any base to send them there.",
    "<b>Tanks</b> drive along roads, through your own bases. <b>Helicopters</b> fly straight to anywhere.",
    "Like fights like first, and one tank is worth two helicopters. If any attackers survive, they take the base.",
    "Spend units to upgrade a base: it builds faster and holds more. Past its cap, it slowly loses units.",
    "<b>Real time</b>: orders go out as you give them. <b>Turns</b>: everyone plans at once, then watches the next 5 seconds play out.",
    "Take every base, or hold the most when time (or the last turn) runs out.",
  ],
  colors: PLAYER_COLORS,
  settings: {
    mode: { label: "Mode", fmt: (v: Mode) => (v === "turns" ? "Turns: plan, then watch" : "Real time") },
    minutes: {
      label: "Time limit",
      fmt: (v: number) => (v ? `${v} minutes` : "None"),
      when: (s: Settings) => s.mode !== "turns",
    },
    turns: {
      label: "Turn limit",
      fmt: (v: number) => (v ? `${v} turns` : "None"),
      when: (s: Settings) => s.mode === "turns",
    },
    plan: {
      label: "Time to plan",
      fmt: (v: number) => (v ? `${v} seconds a turn` : "No limit"),
      when: (s: Settings) => s.mode === "turns",
    },
    map: {
      label: "Map",
      fmt: (v: MapSize) => `${v[0].toUpperCase()}${v.slice(1)} · ${BASES_PER_PLAYER[v]} bases a player`,
    },
  },
  choices: SETTING_CHOICES,
  playerTags: (p) => (p.wins ? `<span class="tag">${p.wins} win${p.wins > 1 ? "s" : ""}</span>` : ""),
  onWelcome: (msg) => msg.t === "welcome" && setBattle(msg.snap),
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s) => (s.phase === "playing" && (me(s)?.slot ?? -1) >= 0 ? "Leave this game? Your bases go neutral." : null),
  isLive: (s) => s.phase === "playing",
});
const canvas = $<HTMLCanvasElement>("game-canvas");
const renderer = new Renderer(canvas);
const attract = new Attract($<HTMLCanvasElement>("attract"));

const me = (s = shell.state): PlayerState | undefined => s?.players.find((p) => p.id === shell.me);
const mine = (b: number) => !!app.battle && app.mySlot >= 0 && app.battle.bases[b]?.owner === app.mySlot;
/** The round's turn, in turns; null in real time. */
const turnOf = (s = shell.state): TurnState | null => (s?.phase === "playing" ? (s.turn ?? null) : null);
/** Turns: planning now, with our copy of the battle where the plan is made. */
const planning = () => {
  const t = turnOf();
  return t?.stage === "plan" && !!app.battle && app.battle.n === t.tick && !app.resyncing;
};
const inCommand = () => {
  const b = app.battle;
  if (shell.screen !== "game" || shell.state?.phase !== "playing" || !b || !b.alive(app.mySlot)) return false;
  return turnOf() ? planning() : b.playing;
};
/** Turns: my plan for the turn being planned. */
const myPlan = (): Cmd[] => {
  const t = turnOf();
  return t?.stage === "plan" && app.planN === t.n ? app.plan : NO_PLAN;
};
const iAmDone = () => !!turnOf()?.done.includes(shell.me ?? "");

const controls = new Controls(canvas, {
  active: inCommand,
  pick: (x, y) => (app.battle ? renderer.pick(app.battle, x, y) : -1),
  mine,
  send: (from, to) => {
    if (!shell.send({ t: "send", from, to, pct: app.pct })) toast("Not connected. Reconnecting…");
  },
  changed: renderOrders,
});

// ------------------------------------------------------------------ the plan

let planCache: { battle: Battle; n: number; plan: Cmd[]; shown: Battle; groups: Group[] } | null = null;

/**
 * What to show: our copy of the battle, or in turns, the battle as my plan would leave it (the
 * units it sends taken out of their bases) and the groups it would send.
 */
function view(): { battle: Battle; groups: Group[] } | null {
  const b = app.battle;
  if (!b) return null;
  const plan = myPlan();
  if (!plan.length) return { battle: b, groups: [] };
  const c = planCache;
  if (c && c.battle === b && c.n === b.n && c.plan === plan) return { battle: c.shown, groups: c.groups };
  const shown = planned(b, plan);
  const groups = shown.groups.filter((g) => g.id >= b.nextId);
  shown.groups = shown.groups.filter((g) => g.id < b.nextId);
  planCache = { battle: b, n: b.n, plan, shown, groups };
  return { battle: shown, groups };
}

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "game") layoutStage();
  if (screen === "home") attract.resize();
}

/** Left the game, or lost it for good. */
function onReset(): void {
  app.battle = null;
  app.mySlot = -1;
  app.feed = [];
  app.plan = NO_PLAN;
  controls.clear();
  $("results").hidden = true;
}

// ------------------------------------------------------------------ messages

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case "snap":
      setBattle(msg.snap);
      break;
    case "f":
      onFrame(msg);
      break;
    case "plan":
      app.plan = msg.c;
      app.planN = msg.n;
      renderHud();
      renderOrders();
      break;
    case "error":
      sfx.deny();
      break;
  }
}

function setBattle(snap: Snapshot | null): void {
  app.resyncing = false;
  if (!snap) return;
  const prev = app.battle;
  const b = Battle.fromSnapshot(snap);
  if (!prev || prev.map.id !== b.map.id || b.n < prev.n) {
    // A new round, or in turns, the same one picked up from an earlier turn after the server
    // restarted: what happened since, and any plan for then, are gone.
    app.feed = [];
    renderFeed();
    controls.clear();
    app.plan = NO_PLAN;
    app.planSeen = 0;
  }
  app.battle = b;
  app.frameAt = performance.now();
  layoutStage();
  renderHud();
  renderScoreboard();
  renderOrders();
}

function requestResync(): void {
  if (app.resyncing) return;
  app.resyncing = shell.send({ t: "resync" });
}

function onFrame(f: Frame): void {
  const b = app.battle;
  if (!b) return requestResync();
  if (f.n <= b.n) return; // already have it
  const events = applyFrame(b, f);
  if (!events) return requestResync();
  app.frameAt = performance.now();
  if (f.ck !== undefined && b.checksum() !== f.ck) {
    console.warn(`The battle drifted from the server at tick ${f.n}; resyncing`);
    requestResync();
  }
  // In turns, the whole plan goes out at once, at the start of the run (the run's own sound says so).
  if (!turnOf()) {
    for (const cmd of f.c ?? []) {
      if (cmd[1] !== app.mySlot) continue;
      if (cmd[0] === "s") sfx.send();
      else sfx.upgrade();
    }
  }
  for (const ev of events) onEvent(ev);
  controls.prune();
  renderHud();
  renderScoreboard();
  renderOrders();
}

function who(slot: number, capital = true): string {
  if (slot === app.mySlot) return `<b>${capital ? "You" : "you"}</b>`;
  const look = app.looks[slot];
  return look ? `<b style="color:${look.color}">${esc(look.name)}</b>` : "<b>Someone</b>";
}

/** Sounds, flashes and the feed, from what happened this tick. */
function onEvent(ev: BattleEvent): void {
  const meSlot = app.mySlot;
  switch (ev.e) {
    case "take":
      renderer.flash(ev.b, app.looks[ev.by]?.color ?? "#fff");
      if (ev.by === meSlot) {
        if (ev.from >= 0) {
          sfx.take();
          pushFeed(`You took a base from ${who(ev.from)}`);
        } else {
          sfx.claim();
        }
      } else if (ev.from === meSlot && meSlot >= 0) {
        sfx.lose();
        pushFeed(`${who(ev.by)} took one of your bases`);
      }
      return;
    case "hold":
      if (ev.by === meSlot) sfx.bounce();
      return;
    case "out":
      if (ev.slot === meSlot) {
        sfx.dead();
        app.outAt = performance.now();
        pushFeed(`<b>You're out.</b> Watch the rest, or leave.`);
      } else {
        sfx.out();
        pushFeed(`${who(ev.slot)} is out`);
      }
      return;
  }
}

function pushFeed(html: string): void {
  app.feed.push({ html, at: performance.now() });
  if (app.feed.length > 5) app.feed.shift();
  renderFeed();
}

function onState(s: GameState, prev: GameState | null): void {
  const mine = me(s);
  if (s.phase === "playing") {
    const looks = Array<Look | null>(MAX_PLAYERS).fill(null);
    for (const p of s.players) if (p.slot >= 0) looks[p.slot] = { color: p.color, name: p.name };
    app.looks = looks;
    app.mySlot = mine?.slot ?? -1;
  }
  if (s.phase === "lobby") {
    app.battle = null;
    app.feed = [];
    app.plan = NO_PLAN;
    controls.clear();
  }
  const turn = turnOf(s);
  const was = prev ? turnOf(prev) : null;
  const playing = app.mySlot >= 0 && !!app.battle?.alive(app.mySlot);
  if (turn?.stage === "plan" && turn.n !== app.planSeen) {
    // Time to plan: a fresh turn.
    app.planSeen = turn.n;
    app.planAt = performance.now();
    if (playing) sfx.turn();
  } else if (turn?.stage === "run" && was?.stage === "plan" && was.n === turn.n) {
    controls.clear();
    sfx.go();
  }
  if (prev?.phase === "playing" && s.phase === "results" && s.results?.winnerId === shell.me) sfx.win();
  if (s.phase !== "lobby") renderGame(s);
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  const b = app.battle;
  const v = view();
  if (shell.screen !== "game" || !b || !v) return;
  const turn = turnOf();
  const scene: Scene = {
    battle: v.battle,
    looks: app.looks,
    me: app.mySlot,
    // Units glide between frames; while everyone plans, nothing moves.
    t: turn?.stage === "plan" ? b.n : b.n + Math.min(1, (now - app.frameAt) / TICK_MS),
    selected: controls.selected,
    hover: controls.hover,
    aim: controls.aim,
    pct: app.pct,
    plan: v.groups,
    turnTick: turn ? turn.tick : -1,
  };
  renderer.draw(scene, now);
  renderClock();
  renderBanner(now);
  ageFeed(now);
}

// ------------------------------------------------------------------ game

function renderGame(s: GameState): void {
  const b = app.battle;
  $("round-label").textContent = b ? `Round ${s.round} · ${b.bases.length} bases` : `Round ${s.round}`;
  renderHud();
  renderScoreboard();
  renderOrders();
  renderResults(s);
}

/** Turns: the turn limit of the round, or 0 for none. */
function turnLimit(b: Battle): number {
  return b.end ? Math.round(b.end / TURN_TICKS) : 0;
}

/** The clock: the time left (or played) in real time; in turns, the time left to plan, or to watch. */
function renderClock(): void {
  const s = shell.state;
  const b = app.battle;
  if (!s || shell.screen !== "game") return;
  const el = $("hud-clock");
  const turn = turnOf(s);
  let label = "Time";
  let text: string;
  let low = false;
  if (b && turn) {
    if (turn.stage === "plan") {
      label = "Plan";
      if (turn.deadline === null) {
        text = "no limit";
      } else {
        const left = Math.max(0, turn.deadline - shell.serverNow());
        text = clock(Math.ceil(left / 1000) * TICKS_PER_SEC);
        low = left <= 5000;
        // A beep a second for the last five, while there's still something to decide.
        const secs = Math.ceil(left / 1000);
        const key = `${turn.n}:${secs}`;
        if (low && secs > 0 && key !== app.beeped && inCommand() && !iAmDone()) {
          app.beeped = key;
          sfx.count();
        }
      }
    } else {
      label = "Battle";
      text = clock(turn.tick + TURN_TICKS - b.n);
    }
  } else if (b && s.phase === "playing") {
    if (b.end) {
      const left = b.end - Math.max(b.n, b.go);
      text = clock(left);
      low = left <= 30 * TICKS_PER_SEC;
    } else {
      text = clock(Math.max(0, b.n - b.go));
    }
  } else {
    text = s.phase === "results" ? "Over" : "—";
  }
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle("low", low);
  const labelEl = $("hud-clock-label");
  if (labelEl.textContent !== label) labelEl.textContent = label;
}

function renderHud(): void {
  const s = shell.state;
  const b = app.battle;
  if (!s || shell.screen !== "game") return;
  const mineP = me(s);
  renderClock();
  const turn = turnOf(s);
  $("hud-turn-stat").hidden = !turn;
  if (turn && b) {
    const limit = turnLimit(b);
    $("hud-turn").textContent = limit ? `${turn.n}/${limit}` : String(turn.n);
  }

  const slot = app.mySlot;
  const main = $("hud-main");
  let html: string;
  if (!b || !mineP || slot < 0 || !b.inRound(slot)) {
    html = `<span class="note">Watching${mineP?.spectator ? " — every seat is taken; you'll get one next round if a seat frees up" : ""}</span>`;
    $("hud-bases").textContent = b ? String(b.bases.length) : "—";
    $("hud-units").textContent = "—";
  } else {
    const ranks = b.ranking();
    const rank = ranks.indexOf(slot) + 1;
    const state = b.alive(slot) ? "" : "out · watching";
    html =
      `<span class="chip" style="background:${mineP.color}"></span><span>${esc(mineP.name)}</span>` +
      (rank ? `<span class="tag">#${rank} of ${ranks.length}</span>` : "") +
      (state ? `<span class="note">${state}</span>` : "");
    $("hud-bases").textContent = `${b.basesOf(slot)}/${b.bases.length}`;
    $("hud-units").textContent = String(b.unitsOf(slot));
  }
  if (main.innerHTML !== html) main.innerHTML = html;
}

/** Why the selected base can't be upgraded now, or null if it can. */
function upgradeBlock(b: Battle, sel: number[]): string | null {
  if (sel.length !== 1) return sel.length ? "Select just one base to upgrade it" : "Select one of your bases to upgrade it";
  const base = b.bases[sel[0]];
  if (base.level >= MAX_LEVEL) return "This base is level 3, as big as it gets";
  const cost = UPGRADE_COST[base.level + 1];
  const have = base.t + base.h;
  if (have < cost)
    return `Upgrading to level ${base.level + 1} costs ${cost} units in the base. It has ${have}${myPlan().length ? " left after your orders" : ""}`;
  return null;
}

/** The send size, the upgrade button, the turn's buttons and the line that says what the selection can do. */
function renderOrders(): void {
  for (const btn of $$<HTMLButtonElement>("[data-pct]"))
    btn.setAttribute("aria-pressed", String(Number(btn.dataset.pct) === app.pct));
  const b = view()?.battle ?? null;
  const up = $<HTMLButtonElement>("upgrade");
  const all = $<HTMLButtonElement>("select-all");
  const undo = $<HTMLButtonElement>("undo");
  const done = $<HTMLButtonElement>("done");
  const tip = $("tip");
  const turn = turnOf();
  const live = inCommand();
  const plan = myPlan();
  all.disabled = !live;
  undo.hidden = done.hidden = !turn;
  $("turn-keys").hidden = !turn;
  $("orders").classList.toggle("idle", !live);
  $("orders").classList.toggle("turns", !!turn);
  undo.disabled = !live;
  undo.setAttribute("aria-disabled", String(!plan.length));
  undo.textContent = plan.length ? `Undo · ${plan.length}` : "Undo";
  done.disabled = !live;
  const finished = iAmDone();
  done.setAttribute("aria-pressed", String(finished));
  done.textContent = finished ? "✓ Done" : "Done";
  done.title = finished
    ? "Waiting for the others. Click to keep planning (Enter)"
    : "Finished planning: the turn plays once everyone is (Enter)";

  if (!b || !live) {
    up.disabled = true;
    up.removeAttribute("aria-disabled");
    up.textContent = "Upgrade";
    up.title = "Upgrade the selected base (U)";
    tip.textContent = idleTip(b);
    return;
  }
  up.disabled = false;
  const sel = controls.selected.filter(mine);
  const why = upgradeBlock(b, sel);
  up.setAttribute("aria-disabled", String(!!why));
  up.title = why ?? "";
  if (sel.length === 1) {
    const base = b.bases[sel[0]];
    if (base.level >= MAX_LEVEL) {
      up.textContent = "Level 3 (max)";
    } else {
      const cost = UPGRADE_COST[base.level + 1];
      const have = base.t + base.h;
      up.textContent = have < cost ? `Upgrade · ${have}/${cost}` : `Upgrade · ${cost}`;
      if (!why) up.title = `Spend ${cost} units: level ${base.level + 1} builds faster and holds more (U)`;
    }
  } else {
    up.textContent = "Upgrade";
  }
  if (!sel.length) {
    if (!turn) tip.textContent = "Drag from your base to a target";
    else if (finished) tip.textContent = waitingFor();
    else if (plan.length) tip.textContent = `${plural(plan.length, "order")} planned · press Done when you're ready`;
    else tip.textContent = "Drag from your base to a target to plan a move";
  } else {
    const tanks = sel.reduce((n, i) => n + b.bases[i].t, 0);
    const helis = sel.reduce((n, i) => n + b.bases[i].h, 0);
    const units =
      [tanks ? plural(tanks, "tank") : "", helis ? plural(helis, "helicopter") : ""].filter(Boolean).join(", ") ||
      (turn ? "no units left to send" : "no units yet");
    tip.textContent = `${plural(sel.length, "base")} · ${units} · now pick a target`;
  }
}

/** The tip while you can't give orders: why not. */
function idleTip(b: Battle | null): string {
  const s = shell.state;
  const turn = turnOf();
  if (!b || s?.phase !== "playing") return "";
  const inRound = app.mySlot >= 0 && b.inRound(app.mySlot);
  if (!turn) return !b.playing && !b.over && inRound ? "Get ready…" : "";
  if (turn.stage === "run") return `Turn ${turn.n} is playing out…`;
  if (!inRound) return `The players are planning turn ${turn.n}`;
  if (!b.alive(app.mySlot)) return "";
  return "Catching up with the battle…";
}

/** Turns: who we're waiting for, once I'm done. */
function waitingFor(): string {
  const s = shell.state;
  const turn = turnOf();
  const b = app.battle;
  if (!s || !turn || !b) return "";
  const names = s.players
    .filter((p) => !p.cpu && p.slot >= 0 && b.alive(p.slot) && !turn.done.includes(p.id) && p.id !== shell.me)
    .map((p) => (p.connected ? p.name : `${p.name} (away)`));
  return names.length ? `Done · waiting for ${names.join(", ")}` : "Done";
}

let lastBoardHtml = "";
function renderScoreboard(): void {
  const b = app.battle;
  const s = shell.state;
  if (!b || !s || shell.screen !== "game") return;
  const turn = turnOf(s);
  const bySlot = new Map(s.players.filter((p) => p.slot >= 0).map((p) => [p.slot, p]));
  const rows = b.ranking().map((slot) => ({ slot, bases: b.basesOf(slot), units: b.unitsOf(slot) }));
  const lead = Math.max(1, ...rows.map((r) => r.bases));
  const html = rows
    .map(({ slot, bases, units }) => {
      const look = app.looks[slot];
      if (!look) return "";
      const you = slot === app.mySlot;
      const out = !b.alive(slot);
      // Turns: who's still planning.
      let status = "";
      const p = bySlot.get(slot);
      if (turn?.stage === "plan" && !out && p) {
        if (p.cpu || turn.done.includes(p.id)) status = `<span class="tag tag-ready">ready</span>`;
        else if (!p.connected) status = `<span class="tag">away</span>`;
        else status = `<span class="tag">planning</span>`;
      }
      return `<li class="${you ? "me" : ""} ${out ? "dead" : ""}">
        <span class="chip" style="background:${look.color}"></span>
        <span class="pname">${esc(look.name)}${you ? ` <span class="tag tag-you">you</span>` : ""} ${status}</span>
        <span class="pct">${bases}</span>
        <span class="meta">${out ? "out" : `${plural(units, "unit")} · ${b.taken[slot]} taken`}</span>
        <span class="bar"><i style="width:${(bases / lead) * 100}%;background:${look.color}"></i></span>
      </li>`;
    })
    .join("");
  if (html !== lastBoardHtml) {
    lastBoardHtml = html;
    $("scoreboard").innerHTML = html;
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

/** The big message over the map: the countdown, GO, each turn, being out, time's up. */
function renderBanner(now: number): void {
  const b = app.battle;
  const s = shell.state;
  let big = "";
  let sub = "";
  let sound = "";
  if (b && s?.phase === "playing") {
    const inRound = app.mySlot >= 0 && b.inRound(app.mySlot);
    const turn = turnOf(s);
    const color = app.looks[app.mySlot]?.color ?? "#fff";
    if (b.over) {
      big = b.end && b.n >= b.end ? "TIME!" : "VICTORY";
    } else if (turn) {
      const alive = inRound && b.alive(app.mySlot);
      if (inRound && !alive && now - app.outAt < 4000) {
        big = "YOU'RE OUT";
        sub = "Every one of your bases fell";
      } else if (turn.stage === "plan" && alive && now - app.planAt < (turn.n === 1 ? 4000 : 1200)) {
        big = `TURN ${turn.n}`;
        if (turn.n === 1) sub = `You're <b style="color:${color}">this colour</b>. Plan your moves, then press Done`;
        else if (turn.n === turnLimit(b)) sub = "The last turn";
      }
    } else if (b.n < b.go) {
      const n = Math.ceil((b.go - b.n) / TICKS_PER_SEC);
      big = String(n);
      if (inRound) sub = `You're <b style="color:${color}">this colour</b>. Drag from your base to a neighbour to take it`;
      sound = `count${n}`;
    } else if (b.n < b.go + TICKS_PER_SEC * 0.8 && inRound) {
      big = "GO!";
      sound = "go";
    } else if (inRound && !b.alive(app.mySlot) && b.n - b.out[app.mySlot] < 4 * TICKS_PER_SEC) {
      big = "YOU'RE OUT";
      sub = "Every one of your bases fell";
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

function renderResults(s: GameState): void {
  const r = s.results;
  const open = s.phase === "results" && !!r;
  $("results").hidden = !open;
  if (!open || !r) return;
  $("results-title").textContent = r.turns ? `Round ${r.round} results · ${plural(r.turns, "turn")}` : `Round ${r.round} results`;
  const winner = r.standings.find((x) => x.id === r.winnerId);
  const you = winner?.id === shell.me;
  const end = r.turns ? "when the last turn ends" : "when time runs out";
  $("results-winner").innerHTML = winner
    ? `<b style="color:${winner.color}">${esc(you ? "You" : winner.name)}</b> ${
        r.how === "conquest"
          ? (you ? "take" : "takes") + " every base!"
          : `${you ? "hold" : "holds"} the most bases ${end}: ${winner.bases} of ${r.total}.`
      }`
    : "It's a draw: nobody holds more bases than everyone else.";
  $("results-rows").innerHTML = r.standings
    .map((x, i) => {
      const p = shell.player(x.id);
      return `<tr class="${x.id === r.winnerId ? "winner" : ""}">
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${x.color}"></span>${esc(x.name)}${x.id === shell.me ? ` <span class="tag tag-you">you</span>` : ""}</span></td>
        <td>${x.alive ? x.bases : "out"}</td><td>${x.alive ? x.units : "—"}</td><td>${x.taken}</td><td>${x.best}</td><td>${p?.wins ?? "—"}</td></tr>`;
    })
    .join("");
  const host = shell.canHost(s);
  const again = $<HTMLButtonElement>("results-again");
  const lobby = $<HTMLButtonElement>("results-lobby");
  again.hidden = lobby.hidden = !host;
  const enough = s.players.filter((p) => !p.spectator && (p.cpu || p.connected)).length >= 2;
  again.disabled = !enough;
  $("results-wait").textContent = host
    ? enough
      ? ""
      : "Need at least two players for another round — add a CPU from the lobby."
    : `Waiting for ${shell.player(s.hostId)?.name ?? "the host"} to start the next round…`;
}

// ------------------------------------------------------------------ orders

function setPct(pct: SendPct): void {
  app.pct = pct;
  renderOrders();
}

function upgradeSelected(): void {
  const b = view()?.battle;
  if (!b || !inCommand()) return;
  const sel = controls.selected.filter(mine);
  const why = upgradeBlock(b, sel);
  if (why) {
    toast(why);
    sfx.deny();
    return;
  }
  shell.send({ t: "up", b: sel[0] });
}

function selectAll(): void {
  const b = app.battle;
  if (!b || !inCommand()) return;
  controls.selectAll(b.bases.map((_, i) => i).filter(mine));
}

/** Turns: take back the last order. */
function undo(): void {
  if (!inCommand()) return;
  if (!myPlan().length) {
    toast("There are no orders to take back");
    sfx.deny();
    return;
  }
  shell.send({ t: "undo" });
}

/** Turns: finished planning, or not after all. */
function toggleDone(): void {
  if (!inCommand()) return;
  shell.send({ t: "done", done: !iAmDone() });
}

// ------------------------------------------------------------------ layout

/** Size the canvas to the column, as tall as the map needs (turned on its side when that fits better). */
function layoutStage(): void {
  if (shell.screen !== "game") return;
  const stage = $("stage");
  const width = stage.clientWidth;
  if (!width) return;
  app.stageWidth = width;
  const top = stage.getBoundingClientRect().top + window.scrollY;
  const narrow = window.innerWidth <= 760;
  const room = Math.max(300, window.innerHeight - top - (narrow ? 10 : 40));
  let height = room;
  const map = app.battle?.map;
  if (map) {
    const { swap, scale } = fitMap(width, room, map);
    height = Math.min(room, Math.ceil(scale * (swap ? map.w : map.h)) + 28);
  }
  renderer.resize(width, height);
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  window.addEventListener("resize", () => (shell.screen === "home" ? attract.resize() : layoutStage()));
  new ResizeObserver(() => {
    if (shell.screen === "game" && $("stage").clientWidth !== app.stageWidth) layoutStage();
  }).observe($("stage"));

  for (const btn of $$<HTMLButtonElement>("[data-pct]")) {
    btn.addEventListener("click", () => {
      setPct(Number(btn.dataset.pct) as SendPct);
      btn.blur();
    });
  }
  const buttons: [string, () => void][] = [
    ["upgrade", upgradeSelected],
    ["select-all", selectAll],
    ["undo", undo],
    ["done", toggleDone],
  ];
  for (const [id, fn] of buttons) {
    $(id).addEventListener("click", (e) => {
      fn();
      (e.currentTarget as HTMLElement).blur();
    });
  }

  window.addEventListener("keydown", (e) => {
    if (shell.screen !== "game" || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
    // A focused button owns Space and Enter.
    if (el?.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
    const k = e.key.toLowerCase();
    if (k === "1" || k === "2" || k === "3") setPct(SEND_PCTS[Number(k) - 1]);
    else if (k === "a") selectAll();
    else if (k === "u") upgradeSelected();
    else if (k === "escape") controls.clear();
    else if (k === "backspace" && turnOf()) undo();
    else if (k === "enter" && turnOf()) toggleDone();
    else return;
    e.preventDefault();
  });
}

wire();
shell.start();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __bj: { app, renderer, shell, controls } });
