import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import { $, esc, personalBest, setHtml } from "@warrick/kit/client/dom";
import { formatClock } from "@warrick/kit/client/format";
import { Feed } from "@warrick/kit/client/hud";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import type { DeathCause, Dir, Frame, Op } from "../shared/board";
import { forEachRunCell } from "../shared/codec";
import { PLAYER_COLORS, RESYNC_MS, TICKS_PER_SEC, TICK_MS } from "../shared/constants";
import {
  BOARD_SIZES,
  SETTING_CHOICES,
  percent,
  type BoardSize,
  type ClientMsg,
  type GameState,
  type PlayerState,
  type ServerMsg,
  type Snapshot,
} from "../shared/protocol";
import { applyFrame, viewFromSnapshot, type RoundView } from "../shared/sim";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { Controls } from "./input";
import { Renderer, type Look, type Scene } from "./render";

// ------------------------------------------------------------------ helpers

/** Ask again for a snapshot if none has come this long after asking (the server may have dropped the ask). */
const RESYNC_RETRY_MS = RESYNC_MS + 500;

// ------------------------------------------------------------------ app state

/** What just happened, over the board. */
const feed = new Feed();

const app = {
  /** Our copy of the round, kept in step by the server's frames. */
  view: null as RoundView | null,
  /** Board slot → how it looks. Kept from the last state seen in play, so the final board keeps its colors. */
  looks: Array<Look | null>(MAX_PLAYERS).fill(null),
  mySlot: -1,
  /** The tick last painted into the renderer, and the palette it used. */
  painted: -1,
  paintKey: "",
  /** When we last asked for a snapshot (performance.now()), while waiting for one. */
  resyncAskedAt: null as number | null,
  /** Why we last died, for the respawn banner. */
  death: null as { by: number; why: DeathCause } | null,
  bannerKey: "",
  sounded: "",
  stageWidth: 0,
};

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "turf-war",
  title: "Turf War",
  prefix: "tw",
  logo: "TURF<br />WAR",
  tagline: "Grab the biggest share of the board.<br />No accounts — just share a code.",
  placeholder: "Painter",
  footer: "Leave your land, draw a loop, come home to claim it. Don't get cut.",
  rules: [
    "Leave your land to draw a trail. Get back home to claim everything the trail encloses.",
    "Cross someone's trail while they're out and they're gone — and their trail becomes yours.",
    "Don't cross your own trail, hit the edge, or meet someone head-on.",
    "Biggest share of the board when time runs out wins.",
  ],
  minPlayers: 1,
  soloRules: [
    "On your own: claim as much of the board as you can before time runs out.",
    "Leave your land to draw a trail. Get back home to claim everything the trail encloses.",
    "Don't cross your own trail or hit the edge: you'd start again from a fresh patch.",
    "Your best share for each board and round length is kept in this browser. Add a CPU or invite a friend for a match.",
  ],
  colors: PLAYER_COLORS,
  settings: {
    roundSeconds: { label: "Round", fmt: (v: number) => `${v / 60} minute${v === 60 ? "" : "s"}` },
    board: {
      label: "Board",
      fmt: (v: BoardSize) => `${v[0].toUpperCase()}${v.slice(1)} · ${BOARD_SIZES[v].w} × ${BOARD_SIZES[v].h}`,
    },
  },
  choices: SETTING_CHOICES,
  playerTags: (p) => (p.wins ? `<span class="tag">${p.wins} win${p.wins > 1 ? "s" : ""}</span>` : ""),
  onWelcome: (msg) => msg.t === "welcome" && setView(msg.snap),
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s) => (s.phase === "playing" && (me(s)?.slot ?? -1) >= 0 ? "Leave this game? Your land disappears." : null),
  isLive: (s) => s.phase === "playing",
});
const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));

const me = (s = shell.state): PlayerState | undefined => s?.players.find((p) => p.id === shell.me);
const playerById = (id: string | null | undefined) => shell.player(id);
const canHost = (s = shell.state) => shell.canHost(s);
const myHead = () => (app.view && app.mySlot >= 0 ? app.view.board.heads[app.mySlot] : null);
/** One player on the board, on their own. Someone dropping in makes it a match. */
const solo = (s = shell.state) => s?.phase === "playing" && s.players.filter((p) => p.slot >= 0).length === 1;
const inPlay = () => {
  const v = app.view;
  return shell.state?.phase === "playing" && !!v && v.n < v.end;
};

const controls = new Controls($("stage"), {
  active: () => shell.screen === "game" && inPlay() && !!myHead()?.alive,
  head: () => {
    const h = myHead();
    return h ? { dir: h.dir, fresh: h.fresh } : null;
  },
  send: (d: Dir) => shell.send({ t: "dir", d }),
});

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "game") layoutStage();
  if (screen === "home") attract.resize();
}

/** Left the game, or lost it for good. */
function onReset(): void {
  app.view = null;
  app.mySlot = -1;
  feed.clear();
  app.death = null;
  $("results").hidden = true;
}

// ------------------------------------------------------------------ messages

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case "snap":
      setView(msg.snap);
      break;
    case "f":
      onFrame(msg);
      break;
  }
}

function setView(snap: Snapshot | null): void {
  app.resyncAskedAt = null;
  if (!snap) return;
  const v = viewFromSnapshot(snap);
  if (!v) return;
  const resized = !app.view || app.view.board.w !== v.board.w || app.view.board.h !== v.board.h;
  if (v.n === 0 || (app.view && v.n < app.view.n)) {
    // A new round.
    feed.clear();
    app.death = null;
  }
  app.view = v;
  app.painted = -1;
  controls.reset();
  if (resized) layoutStage();
  renderHud();
}

/** Ask for a fresh snapshot. The server answers a socket once a second at most, so ask again if none comes. */
function requestResync(): void {
  const now = performance.now();
  if (app.resyncAskedAt !== null && now - app.resyncAskedAt < RESYNC_RETRY_MS) return;
  if (shell.send({ t: "resync" })) app.resyncAskedAt = now;
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
      if (text) feed.push(text);
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

function onState(s: GameState, prev: GameState | null): void {
  const mine = me(s);
  if (s.phase === "playing") {
    const looks = Array<Look | null>(MAX_PLAYERS).fill(null);
    for (const p of s.players) if (p.slot >= 0) looks[p.slot] = { color: p.color, name: p.name };
    app.looks = looks;
    app.mySlot = mine?.slot ?? -1;
  }
  if (s.phase === "lobby") {
    app.view = null;
    feed.clear();
  }
  if (prev?.phase === "playing" && s.phase === "results") {
    const best = soloBest(s);
    if (s.results?.winnerId === shell.me || (best?.fresh && best.prev !== null)) sfx.win();
  }
  if (s.phase !== "lobby") renderGame(s);
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game" || !app.view) return;
  const scene = sceneNow();
  const key = app.looks.map((l) => l?.color ?? "").join();
  if (app.painted !== app.view.n || key !== app.paintKey) {
    renderer.paint(scene);
    app.painted = app.view.n;
    app.paintKey = key;
  }
  renderer.draw(scene, now);
  renderBanner();
  feed.age(now);
}

function sceneNow(): Scene {
  return { board: app.view!.board, looks: app.looks, me: app.mySlot };
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
  const s = shell.state;
  const v = app.view;
  if (!s || shell.screen !== "game") return;
  const mine = me(s);
  const clockEl = $("hud-clock");
  if (v && s.phase === "playing") {
    const left = v.end - Math.max(v.n, v.go);
    clockEl.textContent = formatClock(Math.max(0, left) * TICK_MS);
    clockEl.classList.toggle("low", left <= 10 * TICKS_PER_SEC);
  } else {
    clockEl.textContent = s.phase === "results" ? "0:00" : "—";
    clockEl.classList.remove("low");
  }

  const slot = app.mySlot;
  const main = $("hud-main");
  let html: string;
  if (!mine || (s.phase === "playing" && slot < 0) || mine.spectator) {
    html = `<span class="note">Watching${mine?.spectator ? ` — ${whyWatching(s)}` : ""}</span>`;
    $("hud-land").textContent = "—";
    $("hud-kills").textContent = "—";
    $("hud-deaths").textContent = "—";
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
      (rank && !solo(s) ? `<span class="tag">#${rank} of ${ranks.length}</span>` : "") +
      (solo(s) ? `<span class="tag">solo</span>` : "") +
      (state ? `<span class="note">${state}</span>` : "");
    $("hud-land").textContent = v && slot >= 0 ? percent(v.board.land[slot], v.board.size) : "—";
    $("hud-kills").textContent = v && slot >= 0 ? String(v.kills[slot]) : "—";
    $("hud-deaths").textContent = v && slot >= 0 ? String(v.deaths[slot]) : "—";
  }
  $("hud").classList.toggle("solo", solo(s));
  setHtml(main, html);
}

/** Why a spectator isn't playing, and when they will. */
function whyWatching(s: GameState): string {
  const seated = s.players.filter((p) => !p.spectator).length;
  if (seated >= MAX_PLAYERS) return `all ${MAX_PLAYERS} seats are taken; you'll get one between rounds if a seat frees up`;
  // A seat is free: someone left after you started watching, or you came in just as they were leaving.
  return "you'll get a seat next round";
}
function renderScoreboard(): void {
  const v = app.view;
  if (!v || shell.screen !== "game") return;
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
        <span class="meta">${solo() ? "" : `${v.kills[slot]} kill${v.kills[slot] === 1 ? "" : "s"} · `}${v.deaths[slot]} death${v.deaths[slot] === 1 ? "" : "s"}${status}</span>
        <span class="bar"><i style="width:${(land / lead) * 100}%;background:${look.color}"></i></span>
      </li>`;
    })
    .join("");
  setHtml($("scoreboard"), html);

  // The compact board over the stage on small screens: the top three, and you.
  const top = rows.slice(0, 3);
  const mineRow = rows.find((r) => r.slot === app.mySlot);
  if (mineRow && !top.includes(mineRow)) top.push(mineRow);
  const mini = top
    .map((row) => {
      const { slot, land } = row;
      const look = app.looks[slot]!;
      const rank = rows.indexOf(row) + 1;
      return `<li class="${slot === app.mySlot ? "me" : ""}"><span>${rank}.</span><span class="chip" style="background:${look.color}"></span>
        <span>${slot === app.mySlot ? "You" : esc(look.name)}</span><span>${percent(land, v.board.size)}</span></li>`;
    })
    .join("");
  setHtml($("mini-board"), mini);
}

/** The big message over the board: countdown, GO, why you died, time's up. */
function renderBanner(): void {
  const v = app.view;
  const s = shell.state;
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

/**
 * The solo player's share of the board when time ran out, against their best on this board
 * and round length; null for a match, or someone else's round.
 */
function soloBest(s: GameState): { best: number; prev: number | null; fresh: boolean } | null {
  const r = s.results;
  const x = r?.solo ? r.standings[0] : null;
  if (!r || !x || x.id !== shell.me) return null;
  const { board, roundSeconds } = s.settings;
  return personalBest(`best.${board}.${roundSeconds}`, `${s.code}:${r.round}`, x.cells / r.cells);
}

function renderResults(s: GameState): void {
  const r = s.results;
  const open = s.phase === "results" && !!r;
  $("results").hidden = !open;
  if (!open || !r) return;
  const pcell = (x: { id: string; name: string; color: string }) =>
    `<span class="pcell"><span class="chip" style="background:${x.color}"></span>${esc(x.name)}${x.id === shell.me ? ` <span class="tag tag-you">you</span>` : ""}</span>`;
  if (r.solo) {
    $("results-title").textContent = "Time's up";
    const x = r.standings[0];
    const best = soloBest(s);
    const who = x?.id === shell.me ? "You" : `<b style="color:${x?.color}">${esc(x?.name ?? "")}</b>`;
    $("results-winner").innerHTML = !x
      ? "Nobody was on the board."
      : `${who} ended with <b>${percent(x.cells, r.cells)}</b> of the board (${percent(x.best, r.cells)} at best).` +
        (!best
          ? ""
          : best.fresh && best.prev !== null
            ? ` <b class="best">A new personal best!</b>`
            : best.fresh
              ? " That's your best so far on this board."
              : ` Your best here is ${percent(best.best, 1)}.`);
    $("results-head").innerHTML = `<th></th><th>Player</th><th>Board</th><th>Best</th><th>Deaths</th>`;
    $("results-rows").innerHTML = r.standings
      .map(
        (x) =>
          `<tr><td></td><td>${pcell(x)}</td><td>${percent(x.cells, r.cells)}</td><td>${percent(x.best, r.cells)}</td><td>${x.deaths}</td></tr>`,
      )
      .join("");
  } else {
    $("results-title").textContent = `Round ${r.round} results`;
    const winner = r.standings.find((x) => x.id === r.winnerId);
    $("results-winner").innerHTML = winner
      ? `<b style="color:${winner.color}">${esc(winner.id === shell.me ? "You" : winner.name)}</b> ${winner.id === shell.me ? "take" : "takes"} the board with ${percent(winner.cells, r.cells)}.`
      : "It's a draw.";
    $("results-head").innerHTML = `<th></th><th>Player</th><th>Board</th><th>Best</th><th>Kills</th><th>Deaths</th><th>Wins</th>`;
    $("results-rows").innerHTML = r.standings
      .map((x, i) => {
        const p = playerById(x.id);
        return `<tr class="${x.id === r.winnerId ? "winner" : ""}">
        <td>${i + 1}</td>
        <td>${pcell(x)}</td>
        <td>${percent(x.cells, r.cells)}</td><td>${percent(x.best, r.cells)}</td><td>${x.kills}</td><td>${x.deaths}</td><td>${p?.wins ?? "—"}</td></tr>`;
      })
      .join("");
  }
  const host = canHost(s);
  const again = $<HTMLButtonElement>("results-again");
  const lobby = $<HTMLButtonElement>("results-lobby");
  again.hidden = lobby.hidden = !host;
  // Someone has to be here to play, even on their own.
  const enough = s.players.some((p) => p.cpu || p.connected);
  again.disabled = !enough;
  $("results-wait").textContent = host
    ? enough
      ? ""
      : "Nobody's here to play another round."
    : `Waiting for ${playerById(s.hostId)?.name ?? "the host"} to start the next round…`;
}

// ------------------------------------------------------------------ layout

/** Size the canvas: the whole board when it fits at a playable size, otherwise the space below the HUD. */
function layoutStage(): void {
  if (shell.screen !== "game") return;
  const stage = $("stage");
  const width = stage.clientWidth;
  if (!width) return;
  app.stageWidth = width;
  const top = stage.getBoundingClientRect().top + window.scrollY;
  const narrow = window.innerWidth <= 760;
  const room = Math.max(260, window.innerHeight - top - (narrow ? 10 : 40));
  const size = app.view?.board ?? (shell.state ? BOARD_SIZES[shell.state.settings.board] : null);
  let height = room;
  if (size) {
    const cell = Math.min(width / size.w, room / size.h);
    if (cell >= 7) height = Math.min(room, Math.ceil(cell * size.h));
  }
  renderer.resize(width, height);
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  window.addEventListener("resize", () => (shell.screen === "home" ? attract.resize() : layoutStage()));
  new ResizeObserver(() => {
    if (shell.screen === "game" && $("stage").clientWidth !== app.stageWidth) layoutStage();
  }).observe($("stage"));
}

wire();
shell.start();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __tw: { app, renderer, shell } });
