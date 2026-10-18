import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import { $, $$, esc, toast } from "@warrick/kit/client/dom";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { applyFrame, Battle, type BattleEvent, type Frame, type Snapshot } from "../shared/battle";
import { MAX_LEVEL, PLAYER_COLORS, SEND_PCTS, TICKS_PER_SEC, TICK_MS, UPGRADE_COST, type SendPct } from "../shared/constants";
import { BASES_PER_PLAYER, type MapSize } from "../shared/map";
import { SETTING_CHOICES, type ClientMsg, type GameState, type PlayerState, type ServerMsg } from "../shared/protocol";
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
    "Take every base, or hold the most when time runs out.",
  ],
  colors: PLAYER_COLORS,
  settings: {
    minutes: { label: "Time limit", fmt: (v: number) => (v ? `${v} minutes` : "None") },
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
const inCommand = () => {
  const b = app.battle;
  return shell.screen === "game" && shell.state?.phase === "playing" && !!b && b.playing && b.alive(app.mySlot);
};

const controls = new Controls(canvas, {
  active: inCommand,
  pick: (x, y) => (app.battle ? renderer.pick(app.battle, x, y) : -1),
  mine,
  send: (from, to) => {
    if (!shell.send({ t: "send", from, to, pct: app.pct })) toast("Not connected. Reconnecting…");
  },
  changed: renderOrders,
});

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
    // A new round.
    app.feed = [];
    renderFeed();
    controls.clear();
  }
  app.battle = b;
  app.frameAt = performance.now();
  layoutStage();
  renderHud();
  renderScoreboard();
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
  for (const cmd of f.c ?? []) {
    if (cmd[1] !== app.mySlot) continue;
    if (cmd[0] === "s") sfx.send();
    else sfx.upgrade();
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
    controls.clear();
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
  if (shell.screen !== "game" || !b) return;
  const scene: Scene = {
    battle: b,
    looks: app.looks,
    me: app.mySlot,
    t: b.n + Math.min(1, (now - app.frameAt) / TICK_MS),
    selected: controls.selected,
    hover: controls.hover,
    aim: controls.aim,
    pct: app.pct,
  };
  renderer.draw(scene, now);
  renderBanner();
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

function renderHud(): void {
  const s = shell.state;
  const b = app.battle;
  if (!s || shell.screen !== "game") return;
  const mineP = me(s);
  const clockEl = $("hud-clock");
  if (b && s.phase === "playing") {
    if (b.end) {
      const left = b.end - Math.max(b.n, b.go);
      clockEl.textContent = clock(left);
      clockEl.classList.toggle("low", left <= 30 * TICKS_PER_SEC);
    } else {
      clockEl.textContent = clock(Math.max(0, b.n - b.go));
      clockEl.classList.remove("low");
    }
  } else {
    clockEl.textContent = s.phase === "results" ? "Over" : "—";
    clockEl.classList.remove("low");
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

/** The send size, the upgrade button and the line that says what the selection can do. */
function renderOrders(): void {
  for (const btn of $$<HTMLButtonElement>("[data-pct]"))
    btn.setAttribute("aria-pressed", String(Number(btn.dataset.pct) === app.pct));
  const b = app.battle;
  const up = $<HTMLButtonElement>("upgrade");
  const all = $<HTMLButtonElement>("select-all");
  const tip = $("tip");
  const live = inCommand();
  all.disabled = !live;
  $("orders").classList.toggle("idle", !live);
  if (!b || !live) {
    up.disabled = true;
    up.textContent = "Upgrade";
    up.title = "Upgrade the selected base (U)";
    tip.textContent = b && !b.playing && !b.over && app.mySlot >= 0 ? "Get ready…" : "";
    return;
  }
  const sel = controls.selected.filter(mine);
  if (sel.length === 1) {
    const base = b.bases[sel[0]];
    if (base.level >= MAX_LEVEL) {
      up.disabled = true;
      up.textContent = "Level 3 (max)";
      up.title = "This base is as big as it gets";
    } else {
      const cost = UPGRADE_COST[base.level + 1];
      up.textContent = `Upgrade · ${cost}`;
      up.disabled = base.t + base.h < cost;
      up.title = up.disabled
        ? `Needs ${cost} units in the base to reach level ${base.level + 1} (it has ${base.t + base.h})`
        : `Spend ${cost} units: level ${base.level + 1} builds faster and holds more (U)`;
    }
  } else {
    up.disabled = true;
    up.textContent = "Upgrade";
    up.title = sel.length ? "Select just one base to upgrade it" : "Select one of your bases to upgrade it (U)";
  }
  if (!sel.length) {
    tip.textContent = "Drag from your base to a target";
  } else {
    const tanks = sel.reduce((n, i) => n + b.bases[i].t, 0);
    const helis = sel.reduce((n, i) => n + b.bases[i].h, 0);
    const units =
      [tanks ? plural(tanks, "tank") : "", helis ? plural(helis, "helicopter") : ""].filter(Boolean).join(", ") || "no units yet";
    tip.textContent = `${plural(sel.length, "base")} · ${units} · now pick a target`;
  }
}

let lastBoardHtml = "";
function renderScoreboard(): void {
  const b = app.battle;
  if (!b || shell.screen !== "game") return;
  const rows = b.ranking().map((slot) => ({ slot, bases: b.basesOf(slot), units: b.unitsOf(slot) }));
  const lead = Math.max(1, ...rows.map((r) => r.bases));
  const html = rows
    .map(({ slot, bases, units }) => {
      const look = app.looks[slot];
      if (!look) return "";
      const you = slot === app.mySlot;
      const out = !b.alive(slot);
      return `<li class="${you ? "me" : ""} ${out ? "dead" : ""}">
        <span class="chip" style="background:${look.color}"></span>
        <span class="pname">${esc(look.name)}${you ? ` <span class="tag tag-you">you</span>` : ""}</span>
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

/** The big message over the map: the countdown, GO, being out, time's up. */
function renderBanner(): void {
  const b = app.battle;
  const s = shell.state;
  let big = "";
  let sub = "";
  let sound = "";
  if (b && s?.phase === "playing") {
    const inRound = app.mySlot >= 0 && b.inRound(app.mySlot);
    if (b.n < b.go) {
      const n = Math.ceil((b.go - b.n) / TICKS_PER_SEC);
      big = String(n);
      if (inRound) {
        const color = app.looks[app.mySlot]?.color ?? "#fff";
        sub = `You're <b style="color:${color}">this colour</b>. Drag from your base to a neighbour to take it`;
      }
      sound = `count${n}`;
    } else if (b.over) {
      big = b.end && b.n >= b.end ? "TIME!" : "VICTORY";
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
  $("results-title").textContent = `Round ${r.round} results`;
  const winner = r.standings.find((x) => x.id === r.winnerId);
  const you = winner?.id === shell.me;
  $("results-winner").innerHTML = winner
    ? `<b style="color:${winner.color}">${esc(you ? "You" : winner.name)}</b> ${
        r.how === "conquest"
          ? (you ? "take" : "takes") + " every base!"
          : `${you ? "hold" : "holds"} the most bases when time runs out: ${winner.bases} of ${r.total}.`
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
  const sel = controls.selected.filter(mine);
  if (!inCommand() || sel.length !== 1) return;
  shell.send({ t: "up", b: sel[0] });
}

function selectAll(): void {
  const b = app.battle;
  if (!b || !inCommand()) return;
  controls.selectAll(b.bases.map((_, i) => i).filter(mine));
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
  $("upgrade").addEventListener("click", (e) => {
    upgradeSelected();
    (e.currentTarget as HTMLElement).blur();
  });
  $("select-all").addEventListener("click", (e) => {
    selectAll();
    (e.currentTarget as HTMLElement).blur();
  });

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
    else return;
    e.preventDefault();
  });
}

wire();
shell.start();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __bj: { app, renderer, shell, controls } });
