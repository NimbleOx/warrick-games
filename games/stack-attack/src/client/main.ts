import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import { sfx } from "./audio";
import { $, $$, esc, store } from "@warrick/kit/client/dom";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { NEXT_COUNT, PLAYER_COLORS } from "../shared/constants";
import { Board, Lane, SPIN_FULL, SPIN_NONE, spinName, type LockResult, type Placement } from "../shared/engine";
import {
  SETTING_CHOICES,
  attackScale,
  levelAt,
  type Aim,
  type ClientMsg,
  type GameState,
  type Op,
  type PlayerState,
  type RoundSnap,
  type SeatSnap,
  type ServerMsg,
  type Speed,
} from "../shared/protocol";
import { Attract } from "./attract";
import { Input } from "./input";
import { Pilot, type Action, type Handling } from "./pilot";
import { MINI_H, MINI_W, MiniView, OWN_H, OWN_W, OwnView, type Flash, type Popup } from "./render";

// ------------------------------------------------------------------ helpers

function clock(secs: number): string {
  secs = Math.max(0, Math.round(secs));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ handling

const DEFAULT_HANDLING: Handling = { das: 150, arr: 30, sdf: 20 };
/** The soft drop slider's top notch means "straight to the floor". */
const SDF_MAX = 45;

function loadHandling(): Handling {
  const num = (key: string, d: number, lo: number, hi: number) => {
    const v = Number(store(key));
    return store(key) !== null && Number.isFinite(v) && v >= lo && v <= hi ? v : d;
  };
  return {
    das: num("das", DEFAULT_HANDLING.das, 50, 300),
    arr: num("arr", DEFAULT_HANDLING.arr, 0, 100),
    sdf: num("sdf", DEFAULT_HANDLING.sdf, 0, SDF_MAX),
  };
}

let handling = loadHandling();

// ------------------------------------------------------------------ app state

interface FeedItem {
  html: string;
  at: number;
}

/** A board in the round as this browser sees it. Our own is the pilot's lane. */
interface SeatView {
  slot: number;
  lane: Lane;
  /** Garbage waiting for this board (for our own, the pilot's queue says). */
  pending: number;
  kos: number;
  /** Garbage sent, after the multiplier. */
  atk: number;
  place: number;
  out: boolean;
  popups: Popup[];
  hitAt: number;
  mini: MiniView | null;
  el: HTMLElement | null;
}

interface RoundView {
  n: number;
  seed: number;
  goAt: number;
  speed: Speed;
  who: (string | null)[];
  over: boolean;
}

const app = {
  round: null as RoundView | null,
  seats: [] as (SeatView | null)[],
  mySlot: -1,
  pilot: null as Pilot | null,
  /** The server's epoch for our board: it bumps it whenever it overrules us. */
  epoch: 0,
  /** Board slot → name and colour, kept from the last state seen in play. */
  looks: Array<{ name: string; color: string } | null>(MAX_PLAYERS).fill(null),
  flashes: [] as Flash[],
  popups: [] as Popup[],
  bumpAt: -1e9,
  feed: [] as FeedItem[],
  /** When the results may open (after the last KO has had a moment on screen). */
  resultsAt: 0,
  bannerKey: "",
  sounded: "",
  lastFrame: 0,
  arenaWidth: 0,
  boardsKey: "",
};

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "stack-attack",
  title: "Stack Attack",
  prefix: "sa",
  logo: "STACK<br />ATTACK",
  tagline: "Clear lines, bury your friends.<br />No accounts — just share a code.",
  placeholder: "Stacker",
  footer: "Every line you clear lands on someone else. Last one standing wins.",
  lobbyButtons: `<button class="btn btn-ghost" data-action="handling">Controls</button>`,
  rules: [
    "Everyone gets the same pieces. Clear lines to send garbage to an opponent.",
    "Doubles send 1, triples 2, quads 4. T-spins, back-to-backs and combos send more.",
    "Garbage coming at you shows as a red bar. Clear lines first to cancel it.",
    "Top out and you're out. Pieces fall faster as the round goes on, and later garbage gets multiplied. Last one standing wins.",
  ],
  colors: PLAYER_COLORS,
  settings: {
    speed: { label: "Speed", fmt: (v: Speed) => SPEED_LABELS[v] },
    aim: { label: "Garbage goes to", fmt: (v: Aim) => AIM_LABELS[v] },
  },
  choices: SETTING_CHOICES,
  playerTags: (p) => (p.wins ? `<span class="tag">${p.wins} win${p.wins > 1 ? "s" : ""}</span>` : ""),
  onWelcome: (msg) => msg.t === "welcome" && setRound(msg.snap),
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (): string | null => (playing() && app.pilot && !app.pilot.lane.out ? "Leave this game? You'll be knocked out." : null),
  isLive: (s) => s.phase === "playing",
});
const own = new OwnView($<HTMLCanvasElement>("own-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));

const me = (): PlayerState | undefined => shell.mine;
const playerById = (id: string | null | undefined) => shell.player(id);
const canHost = () => shell.canHost();
const serverNow = () => shell.serverNow();
const mySeat = () => (app.mySlot >= 0 ? app.seats[app.mySlot] : null);
const laneOf = (s: SeatView) => (s.slot === app.mySlot && app.pilot ? app.pilot.lane : s.lane);
const pendingOf = (s: SeatView) => (s.slot === app.mySlot && app.pilot ? app.pilot.lane.pending() : s.pending);
const alive = () => app.seats.filter((s) => s && !s.out).length;
const playing = (): boolean => shell.state?.phase === "playing" && !!app.round && !app.round.over;

const input = new Input(
  {
    active: () => shell.screen === "game" && !!app.pilot?.running && $("handling").hidden === true,
    press: (a: Action) => app.pilot?.press(a, performance.now()),
    release: (a: Action) => app.pilot?.release(a, performance.now()),
  },
  $("touch"),
);

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "game") layoutArena();
  if (screen === "home") attract.resize();
}

/** Left the game, or lost it for good. */
function onReset(): void {
  setRound(null);
  $("results").hidden = true;
}

// ------------------------------------------------------------------ messages

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case "snap":
      setRound(msg.snap);
      break;
    case "f":
      for (const op of msg.o) onOp(op);
      renderScoreboard();
      renderHud();
      break;
    case "fix":
      onFix(msg.s, msg.seat);
      break;
  }
}

function seatFromSnap(slot: number, s: SeatSnap): SeatView {
  return {
    slot,
    lane: Lane.fromSnap(s),
    pending: s.q.reduce((n, g) => n + g.lines, 0),
    kos: s.kos,
    atk: s.atk,
    place: s.place,
    out: s.out || s.place > 0,
    popups: [],
    hitAt: -1e9,
    mini: null,
    el: null,
  };
}

function setRound(snap: RoundSnap | null): void {
  if (!snap) {
    app.round = null;
    app.seats = [];
    app.pilot?.stop();
    app.pilot = null;
    app.mySlot = -1;
    buildBoards();
    return;
  }
  const fresh = !app.round || app.round.n !== snap.round || app.round.seed !== snap.seed;
  app.round = { n: snap.round, seed: snap.seed, goAt: snap.goAt, speed: snap.speed, who: snap.who, over: snap.over };
  app.mySlot = snap.who.indexOf(shell.me);
  if (fresh) {
    app.feed = [];
    app.popups = [];
    app.flashes = [];
    app.resultsAt = 0;
    renderFeed();
  }
  app.seats = snap.seats.map((s, slot) => (s ? seatFromSnap(slot, s) : null));
  app.pilot?.stop();
  app.pilot = null;
  const mine = app.mySlot >= 0 ? snap.seats[app.mySlot] : null;
  if (mine) {
    app.epoch = mine.e;
    const pilot = new Pilot(Lane.fromSnap(mine), () => handling, { locked: onLocked, moved: onMoved });
    pilot.known = mine.g;
    app.pilot = pilot;
  }
  buildBoards();
  renderScoreboard();
  renderHud();
}

/** The server overruled our browser (a bad lock, a stalled tab, the autopilot): take its board. */
function onFix(slot: number, seat: SeatSnap): void {
  const pilot = app.pilot;
  if (slot !== app.mySlot || !pilot) return;
  app.epoch = seat.e;
  const lane = Lane.fromSnap(seat);
  pilot.known = seat.g;
  pilot.reset(lane, performance.now());
  const view = mySeat();
  if (view) {
    view.kos = seat.kos;
    view.out = lane.out;
  }
  if (lane.out) pilot.stop();
  renderHud();
}

function onLocked(pl: Placement, res: LockResult, k: number): void {
  const pilot = app.pilot!;
  shell.send({ t: "lock", e: app.epoch, k, pl, g: pilot.known, ck: pilot.lane.checksum() });
  const now = performance.now();
  const lines = res.cleared.length;
  if (lines) app.flashes.push({ rows: res.cleared, at: now });
  const pop = (text: string, color: string, big = false) => app.popups.push({ text, color, at: now, big });
  if (res.pc) pop("PERFECT CLEAR", "#ffd23f", true);
  if (res.spin === SPIN_FULL || (res.spin !== SPIN_NONE && lines)) pop(spinName(res.spin, lines), "#b48cff", lines >= 2);
  else if (lines >= 2) pop(spinName(SPIN_NONE, lines), lines === 4 ? "#3ff0e0" : "#e9ecf8", lines === 4);
  if (res.b2b) pop("BACK-TO-BACK", "#ffd23f");
  if (res.combo >= 1) pop(`${res.combo} COMBO`, "#ff9a3c");
  if (res.cancelled) pop(`${res.cancelled} BLOCKED`, "#5ce65c");
  const sent = app.round ? Math.round(res.sent * attackScale(app.round.speed, serverNow() - app.round.goAt)) : res.sent;
  if (sent) pop(`+${sent}`, "#ff6bd6", sent >= 4);
  if (app.popups.length > 8) app.popups.splice(0, app.popups.length - 8);

  if (lines) sfx.clear(lines, lines === 4 || res.spin !== SPIN_NONE || res.pc);
  else sfx.lock();
  if (res.inserted) {
    app.bumpAt = now;
    sfx.rise(res.inserted);
  }
  if (res.out) {
    pilot.stop();
    sfx.die();
  }
  renderHud();
}

function onMoved(kind: "shift" | "turn" | "hold" | "land" | "fail"): void {
  if (kind === "shift") sfx.shift();
  else if (kind === "turn") sfx.turn();
  else if (kind === "hold") sfx.hold();
  else if (kind === "land") sfx.land();
  else sfx.fail();
}

function onOp(op: Op): void {
  const now = performance.now();
  if (op.k === "l") {
    const seat = app.seats[op.s];
    if (!seat) return;
    seat.atk = op.atk;
    if (op.s === app.mySlot && app.pilot) return; // we played it already
    const lane = seat.lane;
    lane.board = Board.decode(op.b) ?? lane.board;
    lane.n = op.n;
    lane.hold = op.hold;
    lane.pc = op.pc;
    lane.combo = op.combo;
    lane.b2b = op.b2b;
    lane.lines = op.lines;
    seat.pending = op.q;
    const label = op.pcl ? "PC!" : op.sp && op.c ? (op.sp === SPIN_FULL ? `TS${"SDT"[op.c - 1]}` : "MINI") : op.c >= 3 ? spinName(0, op.c) : "";
    if (label) seat.popups.push({ text: label, color: op.sp ? "#b48cff" : "#3ff0e0", at: now });
    if (op.a >= 2) seat.popups.push({ text: `+${op.a}`, color: "#ff6bd6", at: now });
    if (seat.popups.length > 4) seat.popups.splice(0, seat.popups.length - 4);
  } else if (op.k === "g") {
    if (op.to === app.mySlot && app.pilot) {
      const pilot = app.pilot;
      if (op.id > pilot.known) {
        pilot.lane.queue.push({ id: op.id, lines: op.lines, hole: op.hole, from: op.from });
        pilot.known = op.id;
        sfx.warn();
      }
    } else {
      const seat = app.seats[op.to];
      if (seat) seat.pending += op.lines;
      if (seat && op.from === app.mySlot) {
        seat.hitAt = now;
        sfx.send(op.lines);
      }
    }
  } else if (op.k === "ko") {
    const seat = app.seats[op.s];
    if (!seat) return;
    seat.out = true;
    seat.place = op.place;
    const killer = op.by >= 0 ? app.seats[op.by] : null;
    if (killer) killer.kos++;
    if (op.s === app.mySlot) {
      if (app.pilot && !app.pilot.lane.out) app.pilot.lane.out = true;
      app.pilot?.stop();
    } else if (op.by === app.mySlot) {
      sfx.ko();
      app.popups.push({ text: "K.O.!", color: "#ffd23f", at: now, big: true });
    } else {
      sfx.thud();
    }
    const victim = who(op.s);
    pushFeed(killer ? `${who(op.by)} knocked out ${victim}` : `${victim} ${op.s === app.mySlot ? "are" : "is"} out`);
    // Last one standing.
    if (app.round && alive() <= 1) {
      app.round.over = true;
      for (const s of app.seats) if (s && !s.out) s.place = 1;
      app.pilot?.stop();
      const winner = app.seats.find((s) => s && s.place === 1);
      if (winner) pushFeed(`${who(winner.slot)} ${winner.slot === app.mySlot ? "win" : "wins"}!`);
    }
  }
}

function who(slot: number): string {
  if (slot === app.mySlot) return `<b>You</b>`;
  const look = app.looks[slot];
  return look ? `<b style="color:${look.color}">${esc(look.name)}</b>` : "<b>Someone</b>";
}

function pushFeed(html: string): void {
  app.feed.push({ html, at: performance.now() });
  if (app.feed.length > 5) app.feed.shift();
  renderFeed();
}

function onState(s: GameState, prev: GameState | null): void {
  if (s.phase === "playing") {
    const looks = Array<{ name: string; color: string } | null>(MAX_PLAYERS).fill(null);
    for (const p of s.players) if (p.slot >= 0) looks[p.slot] = { color: p.color, name: p.name };
    app.looks = looks;
  }
  if (s.phase === "lobby" && app.round) setRound(null);
  if (prev?.phase === "playing" && s.phase === "results") {
    // Let the final knockout land before the results cover the boards.
    app.resultsAt = performance.now() + 1600;
    if (app.round) app.round.over = true;
    app.pilot?.stop();
    if (s.results?.winnerId === shell.me) sfx.win();
  }
  if (s.phase !== "lobby") {
    renderGame(s);
    buildBoards();
  }
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = app.lastFrame ? Math.min(100, now - app.lastFrame) : 16;
  app.lastFrame = now;
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game") return;

  const r = app.round;
  const pilot = app.pilot;
  if (r && pilot) {
    const t = serverNow();
    if (!pilot.running && !r.over && t >= r.goAt && !pilot.lane.out && shell.state?.phase === "playing") pilot.start(now);
    pilot.update(now, dt, levelAt(r.speed, t - r.goAt));
  }
  drawBoards(now);
  renderBanner();
  renderClock();
  ageFeed(now);
  if (app.resultsAt && now >= app.resultsAt) {
    app.resultsAt = 0;
    if (shell.state) renderResults(shell.state);
  }
}

function drawBoards(now: number): void {
  const pilot = app.pilot;
  const seat = mySeat();
  if (pilot && seat) {
    app.flashes = app.flashes.filter((f) => now - f.at < 300);
    app.popups = app.popups.filter((p) => now - p.at < 1500);
    const lane = pilot.lane;
    own.draw(
      {
        board: lane.board,
        active: pilot.active,
        ghostY: pilot.ghostY(),
        hold: pilot.holdShown,
        holdUsed: pilot.held,
        next: pilot.active ? pilot.preview(NEXT_COUNT) : [lane.current, ...pilot.preview(NEXT_COUNT - 1)],
        pending: lane.pending(),
        armed: lane.armed(),
        out: lane.out || seat.out,
        place: seat.place,
        flashes: app.flashes,
        popups: app.popups,
        bumpAt: app.bumpAt,
      },
      now,
    );
  }
  for (const s of app.seats) {
    if (!s?.mini) continue;
    s.popups = s.popups.filter((p) => now - p.at < 1500);
    s.mini.draw(
      { board: laneOf(s).board, pending: pendingOf(s), out: s.out, place: s.place, winner: s.place === 1, popups: s.popups, hitAt: s.hitAt },
      now,
    );
  }
}

// ------------------------------------------------------------------ boards: building and layout

/** Slots shown as small boards: everyone but us. */
function miniSlots(): number[] {
  return app.seats.filter((s): s is SeatView => !!s && s.slot !== app.mySlot).map((s) => s.slot);
}

/** (Re)build the small boards when who's in the round changes. */
function buildBoards(): void {
  const slots = miniSlots();
  const key = `${app.round?.n ?? ""}|${app.round?.seed ?? ""}|${app.mySlot}|${slots.join()}|${app.looks.map((l) => l?.color).join()}`;
  $("own").hidden = !app.pilot;
  if (key === app.boardsKey) {
    for (const s of app.seats) if (s?.el) s.el.querySelector(".opp-kos")!.textContent = s.kos ? `${s.kos} KO` : "";
    return;
  }
  app.boardsKey = key;
  // The knockout feed sits over our board, or over everyone's when we're watching.
  (app.pilot ? $("own") : $("arena")).append($("feed"));
  const box = $("opps");
  box.innerHTML = "";
  for (const slot of slots) {
    const seat = app.seats[slot]!;
    const look = app.looks[slot];
    const el = document.createElement("div");
    el.className = "opp";
    el.innerHTML = `<div class="opp-head"><span class="chip" style="background:${look?.color ?? "#888"}"></span>
      <span class="opp-name">${esc(look?.name ?? "?")}</span><span class="opp-kos"></span></div><canvas></canvas>`;
    box.append(el);
    seat.el = el;
    seat.mini = new MiniView(el.querySelector("canvas")!);
  }
  layoutArena();
}

/** Size our board and the others' to fill the space: ours big, theirs in a grid beside it (or above, on phones). */
function layoutArena(): void {
  if (shell.screen !== "game") return;
  const arena = $("arena");
  const W = arena.clientWidth;
  if (!W) return;
  app.arenaWidth = W;
  const touch = $("touch");
  const top = arena.getBoundingClientRect().top + window.scrollY;
  const narrow = W < 640;
  const below = touch.hidden ? (narrow ? 8 : 40) : touch.offsetHeight + 16;
  const H = Math.max(260, window.innerHeight - top - below);
  const slots = miniSlots();
  const n = slots.length;
  const hasOwn = !!app.pilot;
  const LABEL = 20;
  const GAP = 10;

  // Biggest cell size that fits every small board in the space given.
  const fit = (w: number, h: number) => {
    let best = 3;
    for (let cols = 1; cols <= Math.max(1, n); cols++) {
      const rows = Math.ceil(n / cols);
      best = Math.max(best, Math.floor(Math.min((w / cols - GAP) / MINI_W, (h / rows - LABEL - GAP) / MINI_H)));
    }
    return best;
  };

  let c = 0;
  let best = fit(W, H);
  if (hasOwn) {
    if (narrow) {
      const strip = n ? Math.min(H * 0.26, 150) : 0;
      c = Math.floor(Math.min(W / OWN_W, (H - strip - GAP) / OWN_H));
      best = fit(W, Math.max(60, H - Math.ceil(c * OWN_H) - GAP));
    } else {
      // Shrink our board until the others are a fair size beside it: as big as ours with one
      // opponent, down to about 40% with seven.
      const want = n <= 1 ? 0.9 : n <= 3 ? 0.55 : 0.4;
      for (c = Math.floor(Math.min(H / OWN_H, 34)); c > 8; c--) {
        best = fit(W - Math.ceil(c * OWN_W) - GAP * 2, H);
        if (!n || best >= c * want) break;
      }
      best = fit(W - Math.ceil(c * OWN_W) - GAP * 2, H);
    }
    own.resize(Math.max(8, c));
  }
  arena.classList.toggle("stacked", hasOwn && narrow);

  const m = Math.max(3, Math.min(best, hasOwn ? Math.max(8, c) : 30));
  for (const slot of slots) {
    const seat = app.seats[slot]!;
    seat.mini?.resize(m);
    if (seat.el) seat.el.style.width = `${Math.round(MINI_W * m)}px`;
  }
  $("opps").classList.toggle("tiny", m < 9);
}

// ------------------------------------------------------------------ settings

const SPEED_LABELS: Record<Speed, string> = {
  relaxed: "Relaxed · starts slow",
  normal: "Normal",
  frantic: "Frantic · starts fast",
};
const AIM_LABELS: Record<Aim, string> = {
  random: "A random opponent",
  strongest: "Whoever's doing best",
  weakest: "Whoever's closest to topping out",
};
// ------------------------------------------------------------------ game

function renderGame(s: GameState): void {
  const n = app.seats.filter(Boolean).length;
  $("round-label").textContent = app.round ? `Round ${app.round.n} · ${n} players` : `Round ${s.round}`;
  renderHud();
  renderScoreboard();
  if (s.phase === "results") {
    if (!app.resultsAt) renderResults(s);
  } else {
    $("results").hidden = true;
  }
}

function renderHud(): void {
  const s = shell.state;
  if (!s || shell.screen !== "game") return;
  const mine = me();
  const seat = mySeat();
  const lane = app.pilot?.lane;
  const left = alive();
  const total = app.seats.filter(Boolean).length;
  let html: string;
  if (!mine || !seat || !lane) {
    html = `<span class="note">Watching${mine?.spectator ? " — you'll get a seat next round" : ""}</span>`;
  } else {
    const status = seat.place === 1 && app.round?.over ? "winner!" : seat.out ? `out · #${seat.place}` : app.round?.over ? "" : "in play";
    html =
      `<span class="chip" style="background:${mine.color}"></span><span>${esc(mine.name)}</span>` +
      (total ? `<span class="tag">${left} of ${total} left</span>` : "") +
      (status ? `<span class="note">${status}</span>` : "");
  }
  const main = $("hud-main");
  if (main.innerHTML !== html) main.innerHTML = html;
  $("hud-lines").textContent = lane ? String(lane.lines) : "—";
  $("hud-sent").textContent = seat ? String(seat.atk) : "—";
  $("hud-kos").textContent = seat ? String(seat.kos) : "—";
}

/** The level and the garbage multiplier go up on their own, so they're refreshed every frame. */
function renderClock(): void {
  const r = app.round;
  const t = r ? serverNow() - r.goAt : 0;
  const level = r ? String(levelAt(r.speed, t)) : "—";
  const scale = r ? attackScale(r.speed, t) : 1;
  const el = $("hud-level");
  if (el.textContent !== level) el.textContent = level;
  const x = $("hud-scale");
  const text = `×${scale}`;
  if (x.textContent !== text) {
    x.textContent = text;
    x.classList.toggle("hot", scale > 1);
    x.title = scale > 1 ? `Garbage sent is multiplied by ${scale} to bring the round to an end` : "";
  }
}

let lastBoardHtml = "";
function renderScoreboard(): void {
  if (shell.screen !== "game") return;
  const rows = app.seats
    .filter((s): s is SeatView => !!s)
    .sort((a, b) => (a.out ? a.place || 99 : 0) - (b.out ? b.place || 99 : 0) || a.slot - b.slot);
  const html = rows
    .map((seat) => {
      const look = app.looks[seat.slot];
      const lane = laneOf(seat);
      const you = seat.slot === app.mySlot;
      const status = seat.place === 1 && app.round?.over ? "winner" : seat.out ? `#${seat.place}` : "";
      return `<li class="${you ? "me" : ""} ${seat.out && seat.place !== 1 ? "dead" : ""}">
        <span class="chip" style="background:${look?.color ?? "#888"}"></span>
        <span class="pname">${esc(look?.name ?? "?")}${you ? ` <span class="tag tag-you">you</span>` : ""}</span>
        <span class="pct">${status}</span>
        <span class="meta">${seat.kos} KO · ${seat.atk} sent · ${lane.lines} lines</span>
      </li>`;
    })
    .join("");
  if (html !== lastBoardHtml) {
    lastBoardHtml = html;
    $("scoreboard").innerHTML = html;
  }
  buildBoards();
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

/** The big message over our board: the countdown, then GO. */
function renderBanner(): void {
  const r = app.round;
  let big = "";
  let sub = "";
  let sound = "";
  if (r && shell.state?.phase === "playing" && !r.over) {
    const until = r.goAt - serverNow();
    if (until > 0) {
      const n = Math.ceil(until / 1000);
      big = String(n);
      sub = app.pilot ? "Last one standing wins" : "";
      sound = `count${n}-${r.n}`;
    } else if (until > -800 && app.pilot) {
      big = "GO!";
      sound = `go-${r.n}`;
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
  el.innerHTML = big ? `<div class="big">${esc(big)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}` : "";
}

function renderResults(s: GameState): void {
  const r = s.results;
  const open = s.phase === "results" && !!r;
  $("results").hidden = !open;
  if (!open || !r) return;
  $("results-title").textContent = `Round ${r.round} results`;
  const winner = r.standings.find((x) => x.id === r.winnerId);
  $("results-winner").innerHTML = winner
    ? `<b style="color:${winner.color}">${esc(winner.id === shell.me ? "You" : winner.name)}</b> ${winner.id === shell.me ? "are" : "is"} the last one standing.`
    : "Nobody made it.";
  $("results-rows").innerHTML = r.standings
    .map((x) => {
      const p = playerById(x.id);
      return `<tr class="${x.id === r.winnerId ? "winner" : ""}">
        <td>${x.place}</td>
        <td><span class="pcell"><span class="chip" style="background:${x.color}"></span>${esc(x.name)}${x.id === shell.me ? ` <span class="tag tag-you">you</span>` : ""}</span></td>
        <td>${x.kos}</td><td>${x.sent}</td><td>${x.lines}</td><td>${x.pieces}</td><td>${clock(x.secs)}</td><td>${p?.wins ?? "—"}</td></tr>`;
    })
    .join("");
  const host = canHost();
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

// ------------------------------------------------------------------ controls dialog

function openHandling(): void {
  input.releaseAll();
  paintHandling();
  $("handling").hidden = false;
}

function paintHandling(): void {
  $<HTMLInputElement>("h-das").value = String(handling.das);
  $<HTMLInputElement>("h-arr").value = String(handling.arr);
  $<HTMLInputElement>("h-sdf").value = String(handling.sdf === 0 ? SDF_MAX : handling.sdf);
  $("h-das-out").textContent = `${handling.das} ms`;
  $("h-arr-out").textContent = handling.arr === 0 ? "instant" : `${handling.arr} ms`;
  $("h-sdf-out").textContent = handling.sdf === 0 ? "instant" : `${handling.sdf}×`;
}

function saveHandling(): void {
  const sdf = Number($<HTMLInputElement>("h-sdf").value);
  handling = {
    das: Number($<HTMLInputElement>("h-das").value),
    arr: Number($<HTMLInputElement>("h-arr").value),
    sdf: sdf >= SDF_MAX ? 0 : sdf,
  };
  store("das", String(handling.das));
  store("arr", String(handling.arr));
  store("sdf", String(handling.sdf));
  paintHandling();
}

// ------------------------------------------------------------------ wiring

function showTouch(on: boolean): void {
  $("touch").hidden = !on;
  $("keys-hint").hidden = on;
  layoutArena();
}

function wire(): void {
  window.addEventListener("resize", () => (shell.screen === "home" ? attract.resize() : layoutArena()));
  new ResizeObserver(() => {
    if (shell.screen === "game" && $("arena").clientWidth !== app.arenaWidth) layoutArena();
  }).observe($("arena"));
  if (window.matchMedia?.("(pointer: coarse)").matches) showTouch(true);
  window.addEventListener("touchstart", () => $("touch").hidden && showTouch(true), { once: true, passive: true });

  // Controls dialog
  for (const b of $$("[data-action=handling]")) {
    b.addEventListener("click", () => {
      b.blur();
      openHandling();
    });
  }
  for (const id of ["h-das", "h-arr", "h-sdf"]) $(id).addEventListener("input", saveHandling);
  const closeHandling = () => ($("handling").hidden = true);
  $("handling-close").addEventListener("click", closeHandling);
  $("handling-done").addEventListener("click", closeHandling);
  $("handling").addEventListener("click", (e) => e.target === e.currentTarget && closeHandling());
  $("handling-reset").addEventListener("click", () => {
    handling = { ...DEFAULT_HANDLING };
    paintHandling();
    saveHandling();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("handling").hidden) closeHandling();
  });
}

wire();
shell.start();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __sa: { app, own, shell } });
