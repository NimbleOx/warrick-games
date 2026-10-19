import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import { $, esc, personalBest, setHtml, setText } from "@warrick/kit/client/dom";
import { formatClock } from "@warrick/kit/client/format";
import { Feed } from "@warrick/kit/client/hud";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { Board, Lane, type Dir, type MoveResult } from "../shared/engine";
import {
  SETTING_CHOICES,
  SOLO_GOAL,
  attackScale,
  type Aim,
  type ClientMsg,
  type GameState,
  type Goal,
  type Op,
  type PlayerState,
  type RoundSnap,
  type SeatSnap,
  type ServerMsg,
  type Size,
} from "../shared/protocol";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { Input } from "./input";
import { MiniView, OwnView, miniHeight, miniWidth, ownHeight, ownWidth, type Anim, type Popup } from "./render";

// ------------------------------------------------------------------ helpers

const tile = (v: number) => (v > 0 ? String(2 ** v) : "—");

const GOAL_LABELS: Record<Goal, string> = {
  0: "Last one standing",
  256: "First to 256",
  512: "First to 512",
  1024: "First to 1024",
};
const SIZE_LABELS: Record<Size, string> = {
  4: "4 × 4 · classic",
  5: "5 × 5 · roomier",
};
const AIM_LABELS: Record<Aim, string> = {
  random: "A random opponent",
  leader: "Whoever's in the lead",
  weakest: "Whoever's closest to full",
};
const COMBO_NAMES = ["", "", "", "TRIPLE!", "QUAD!"];

// ------------------------------------------------------------------ app state

/** A board in the round as this browser sees it. Our own is `app.lane`. */
interface SeatView {
  slot: number;
  lane: Lane;
  /** Rocks on their way to this board (for our own, our lane's queue says). */
  pending: number;
  kos: number;
  /** Rocks sent, after the multiplier. */
  atk: number;
  place: number;
  out: boolean;
  /** Made SOLO_GOAL, playing on their own. */
  won: boolean;
  popups: Popup[];
  hitAt: number;
  landAt: number;
  mini: MiniView | null;
  el: HTMLElement | null;
}

interface RoundView {
  n: number;
  seed: number;
  goAt: number;
  size: Size;
  goal: Goal;
  who: (string | null)[];
  over: boolean;
  /** One player on their own: make 2048, then keep going until there are no moves left. */
  solo: boolean;
}

/** What just happened, over the board. */
const feed = new Feed();

const app = {
  round: null as RoundView | null,
  seats: [] as (SeatView | null)[],
  mySlot: -1,
  /** Our own board, played here and checked by the server. */
  lane: null as Lane | null,
  /** The newest garbage id we've heard about. */
  known: 0,
  /** The server's epoch for our board: it bumps it whenever it overrules us. */
  epoch: 0,
  /**
   * Our moves reach the server. False once one couldn't be sent, until the welcome after
   * reconnecting brings our board back; meanwhile the shell shows "Reconnecting…".
   */
  connected: true,
  anim: null as Anim | null,
  popups: [] as Popup[],
  bumpAt: -1e9,
  firedAt: -1e9,
  nudge: null as { dir: Dir; at: number } | null,
  /** Board slot → name and colour, kept from the last state seen in play. */
  looks: Array<{ name: string; color: string } | null>(MAX_PLAYERS).fill(null),
  /** When the results may open (after the last moment has had a beat on screen). */
  resultsAt: 0,
  sounded: "",
  arenaWidth: 0,
  boardsKey: "",
  /** The HUD and scoreboard are out of date: the next frame renders them. */
  hudDirty: false,
};

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "double-trouble",
  title: "Double Trouble",
  prefix: "dt",
  logo: "DOUBLE<br />TROUBLE",
  tagline: "2048, head to head. Merge tiles,<br />bury your friends in rocks.",
  placeholder: "Merger",
  footer: "Every merge charges a rock for someone else. Run out of moves and you're out.",
  rules: [
    "Everyone plays their own 2048 board at once and gets the same tiles. Slide with the arrow keys, WASD or a swipe.",
    "Merges charge your power meter, and each time it fills a rock lands on an opponent. Bigger merges, and several in one move, charge it faster.",
    "Rocks slide but never merge: merge right next to one to smash it. Rocks coming at you land on your third move, and your own merges smash them first.",
    "Run out of moves and you're out. Make the goal tile first, or be the last one standing. After two minutes rocks come in bigger batches.",
  ],
  minPlayers: 1,
  soloRules: [
    "On your own, it's 2048: slide with the arrow keys, WASD or a swipe, and merge tiles. No rocks.",
    "Make a 2048 tile and you've won, but keep going: the round ends when you run out of moves.",
    "Your best score on each board size is kept in this browser. Add a CPU or invite a friend for a match instead.",
  ],
  settings: {
    goal: { label: "Win by", fmt: (v: Goal) => GOAL_LABELS[v] },
    size: { label: "Board", fmt: (v: Size) => SIZE_LABELS[v] },
    aim: { label: "Rocks go to", fmt: (v: Aim) => AIM_LABELS[v] },
  },
  choices: SETTING_CHOICES,
  playerTags: (p) => (p.wins ? `<span class="tag">${p.wins} win${p.wins > 1 ? "s" : ""}</span>` : ""),
  onWelcome: (msg) => {
    if (msg.t !== "welcome") return;
    app.connected = true;
    setRound(msg.snap);
  },
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (): string | null => (playing() && app.lane && !app.lane.out ? "Leave this game? You'll be knocked out." : null),
  isLive: (s) => s.phase === "playing",
});
const own = new OwnView($<HTMLCanvasElement>("own-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));

const me = (): PlayerState | undefined => shell.mine;
const serverNow = () => shell.serverNow();
const mySeat = () => (app.mySlot >= 0 ? app.seats[app.mySlot] : null);
const laneOf = (s: SeatView) => (s.slot === app.mySlot && app.lane ? app.lane : s.lane);
const pendingOf = (s: SeatView) => (s.slot === app.mySlot && app.lane ? app.lane.pending() : s.pending);
const alive = () => app.seats.filter((s) => s && !s.out).length;
const playing = (): boolean => shell.state?.phase === "playing" && !!app.round && !app.round.over;
const solo = (): boolean => !!app.round?.solo;
/** Whether our moves count right now: in the round, past the countdown, not out, and connected. */
const canPlay = (): boolean =>
  shell.screen === "game" &&
  playing() &&
  app.connected &&
  !!app.lane &&
  !app.lane.out &&
  serverNow() >= app.round!.goAt &&
  !mySeat()?.place;

new Input({ active: canPlay, move: tryMove }, $("own"));

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
      // The boards take every op at once; the HUD and scoreboard catch up on the next frame.
      for (const op of msg.o) onOp(op);
      renderSoon();
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
    pending: s.q.reduce((n, g) => n + g.rocks, 0),
    kos: s.kos,
    atk: s.atk,
    place: s.place,
    out: s.out,
    won: !!s.won,
    popups: [],
    hitAt: -1e9,
    landAt: -1e9,
    mini: null,
    el: null,
  };
}

function setRound(snap: RoundSnap | null): void {
  if (!snap) {
    app.round = null;
    app.seats = [];
    app.lane = null;
    app.mySlot = -1;
    app.anim = null;
    buildBoards();
    return;
  }
  const fresh = !app.round || app.round.n !== snap.round || app.round.seed !== snap.seed;
  app.round = {
    n: snap.round,
    seed: snap.seed,
    goAt: snap.goAt,
    size: snap.size,
    goal: snap.goal,
    who: snap.who,
    over: snap.over,
    solo: !!snap.solo,
  };
  app.mySlot = snap.who.indexOf(shell.me);
  if (fresh) {
    feed.clear();
    app.popups = [];
    app.resultsAt = 0;
  }
  app.seats = snap.seats.map((s, slot) => (s ? seatFromSnap(slot, s) : null));
  app.anim = null;
  const mine = app.mySlot >= 0 ? snap.seats[app.mySlot] : null;
  app.lane = mine ? Lane.fromSnap(mine) : null;
  app.epoch = mine?.e ?? 0;
  app.known = mine?.g ?? 0;
  app.boardsKey = "";
  buildBoards();
  renderScoreboard();
  renderHud();
}

/** The server overruled our browser (a move it couldn't match, or rocks dropped while we sat still): take its board. */
function onFix(slot: number, seat: SeatSnap): void {
  if (slot !== app.mySlot || !app.lane) return;
  const before = app.lane.board;
  const lane = Lane.fromSnap(seat);
  app.lane = lane;
  app.epoch = seat.e;
  app.known = Math.max(app.known, seat.g);
  // Show any rocks that appeared dropping in.
  const landed = lane.board.cells.flatMap((v, i) => (v < 0 && before.cells[i] >= 0 ? [i] : []));
  app.anim = landed.length ? { tweens: [], merged: [], hits: [], landed, spawn: -1, at: performance.now() - 90 } : null;
  if (landed.length) {
    app.bumpAt = performance.now();
    sfx.land(landed.length);
  }
  const view = mySeat();
  if (view) {
    view.kos = seat.kos;
    view.atk = seat.atk;
    if (lane.out) view.out = true;
  }
  renderSoon();
}

/**
 * A key or a swipe: play it here straight away and tell the server. It's played on a copy of
 * our board, which becomes the board only if the move reaches the server: one made while the
 * connection is down would be undone by the welcome when it's back.
 */
function tryMove(dir: Dir): void {
  const lane = app.lane;
  if (!lane || !canPlay()) return;
  const now = performance.now();
  const k = lane.n;
  const best = lane.best;
  const next = Lane.fromSnap(lane.snap());
  const res = next.move(dir, app.known);
  const sent = !!res && shell.send({ t: "mv", e: app.epoch, k, d: dir, g: app.known, ck: next.checksum() });
  if (!sent) {
    if (res) app.connected = false;
    app.nudge = { dir, at: now };
    sfx.bump();
    return;
  }
  app.lane = next;
  app.anim = { ...res, at: now };
  moved(res, best, now);
}

function moved(res: MoveResult, before: number, now: number): void {
  const lane = app.lane!;
  const pop = (text: string, color: string, big = false) => app.popups.push({ text, color, at: now, big });
  const smashed = res.hits.filter((h) => h.hp === 0).length;
  if (lane.best > before && lane.best >= 7) pop(`${2 ** lane.best}!`, "#ffd23f", true);
  if (res.combo >= 3) pop(COMBO_NAMES[res.combo] ?? `${res.combo}× COMBO!`, "#ff9a3c", res.combo >= 4);
  if (smashed) pop(smashed > 1 ? `SMASH ×${smashed}` : "SMASH!", "#5ce65c");
  if (res.cancelled) pop(`${res.cancelled} BLOCKED`, "#5ce65c");
  const sent = app.round ? Math.round(res.sent * attackScale(serverNow() - app.round.goAt)) : res.sent;
  if (sent) {
    pop(`+${sent} ROCK${sent > 1 ? "S" : ""}`, "#ff6bd6", sent >= 3);
    app.firedAt = now;
  }
  if (app.popups.length > 6) app.popups.splice(0, app.popups.length - 6);

  if (res.combo) sfx.merge(Math.max(...res.merged.map((c) => lane.board.cells[c])), res.combo);
  else sfx.slide();
  if (smashed) sfx.smash();
  if (lane.best > before && lane.best >= 7) sfx.best(lane.best);
  if (res.landed.length) {
    app.bumpAt = now + 120;
    setTimeout(() => sfx.land(res.landed.length), 120);
  }
  if (res.out) sfx.die();
  renderSoon();
}

function onOp(op: Op): void {
  const now = performance.now();
  if (op.k === "m") {
    const seat = app.seats[op.s];
    if (!seat) return;
    seat.atk = op.atk;
    if (op.s === app.mySlot && app.lane) return; // we played it already (or a fix is on its way)
    const lane = seat.lane;
    const best = lane.best;
    lane.board = Board.decode(op.b, lane.size) ?? lane.board;
    lane.n = op.n;
    lane.score = op.score;
    lane.charge = op.charge;
    lane.smashed = op.smashed;
    seat.pending = op.q;
    if (op.ins) seat.landAt = now;
    if (op.c >= 3) seat.popups.push({ text: `${op.c}×`, color: "#ff9a3c", at: now });
    if (op.a >= 2) seat.popups.push({ text: `+${op.a}`, color: "#ff6bd6", at: now });
    if (lane.best > best && lane.best >= 8) {
      seat.popups.push({ text: tile(lane.best), color: "#ffd23f", at: now });
      feed.push(`${who(op.s)} made <b class="t">${tile(lane.best)}</b>`);
    }
    if (seat.popups.length > 3) seat.popups.splice(0, seat.popups.length - 3);
  } else if (op.k === "g") {
    if (op.to === app.mySlot && app.lane) {
      if (op.id > app.known) {
        app.lane.queue.push({ id: op.id, rocks: op.rocks, from: op.from, at: -1 });
        app.known = op.id;
        sfx.warn();
      }
    } else {
      const seat = app.seats[op.to];
      if (seat) seat.pending += op.rocks;
      if (seat && op.from === app.mySlot) {
        seat.hitAt = now;
        sfx.send(op.rocks);
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
      if (app.lane) app.lane.out = true;
    } else if (op.by === app.mySlot) {
      sfx.ko();
      app.popups.push({ text: "K.O.!", color: "#ffd23f", at: now, big: true });
    } else {
      sfx.thud();
    }
    const victim = who(op.s);
    if (solo()) {
      feed.push(`${victim} ${op.s === app.mySlot ? "are" : "is"} out of moves`);
      if (app.round) app.round.over = true;
      return;
    }
    feed.push(killer ? `${who(op.by)} knocked out ${victim}` : `${victim} ${op.s === app.mySlot ? "are" : "is"} out`);
    // Last one standing.
    if (app.round && alive() <= 1) {
      app.round.over = true;
      for (const s of app.seats) if (s && !s.out) s.place = 1;
      const winner = app.seats.find((s) => s && s.place === 1);
      if (winner) feed.push(`${who(winner.slot)} ${winner.slot === app.mySlot ? "win" : "wins"}!`);
    }
  } else if (op.k === "goal") {
    const seat = app.seats[op.s];
    if (!seat || !app.round) return;
    if (solo()) {
      // A win, and the round goes on.
      seat.won = true;
      const mine = op.s === app.mySlot;
      if (mine) {
        app.popups.push({ text: "YOU WIN!", color: "#ffd23f", at: now, big: true });
        sfx.win();
      }
      feed.push(`${who(op.s)} made <b class="t">${SOLO_GOAL}</b> and ${mine ? "win! Keep going" : "wins!"}`);
      return;
    }
    app.round.over = true;
    seat.place = 1;
    const mine = op.s === app.mySlot;
    if (!mine && app.lane && !app.lane.out) sfx.lose();
    feed.push(`${who(op.s)} made <b class="t">${app.round.goal}</b> and ${mine ? "win" : "wins"}!`);
  }
}

function who(slot: number): string {
  if (slot === app.mySlot) return `<b>You</b>`;
  const look = app.looks[slot];
  return look ? `<b style="color:${look.color}">${esc(look.name)}</b>` : "<b>Someone</b>";
}

function onState(s: GameState, prev: GameState | null): void {
  if (s.phase === "playing") {
    const looks = Array<{ name: string; color: string } | null>(MAX_PLAYERS).fill(null);
    for (const p of s.players) if (p.slot >= 0) looks[p.slot] = { color: p.color, name: p.name };
    app.looks = looks;
  }
  if (s.phase === "lobby" && app.round) setRound(null);
  if (prev?.phase === "playing" && s.phase === "results") {
    // Let the last moment land before the results cover the boards.
    app.resultsAt = performance.now() + 1600;
    if (app.round) app.round.over = true;
    // Everyone's place, for the boards' overlays.
    for (const st of s.results?.standings ?? []) {
      const slot = app.round?.who.indexOf(st.id) ?? -1;
      const seat = slot >= 0 ? app.seats[slot] : null;
      if (seat) seat.place = st.place;
    }
    if (s.results?.winnerId === shell.me || (s.results?.solo && soloBest(s)?.fresh)) sfx.win();
  }
  if (s.phase !== "lobby") {
    renderGame(s);
    buildBoards();
  }
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game") return;
  if (app.hudDirty) {
    app.hudDirty = false;
    renderScoreboard();
    renderHud();
  }
  drawBoards(now);
  renderBanner();
  renderClock();
  feed.age(now);
  if (app.resultsAt && now >= app.resultsAt) {
    app.resultsAt = 0;
    if (shell.state) renderResults(shell.state);
  }
}

function drawBoards(now: number): void {
  const lane = app.lane;
  const seat = mySeat();
  if (lane && seat) {
    app.popups = app.popups.filter((p) => now - p.at < 1500);
    own.draw(
      {
        board: lane.board,
        anim: app.anim,
        pending: lane.pending(),
        armed: lane.armed(),
        charge: lane.charge,
        firedAt: app.firedAt,
        out: lane.out || seat.out,
        // Nobody places on their own.
        place: solo() ? 0 : seat.place,
        won: seat.won,
        solo: solo(),
        popups: app.popups,
        bumpAt: app.bumpAt,
        nudge: app.nudge,
        waiting: !!app.round && serverNow() < app.round.goAt,
      },
      now,
    );
  }
  for (const s of app.seats) {
    if (!s?.mini) continue;
    s.popups = s.popups.filter((p) => now - p.at < 1500);
    s.mini.draw(
      {
        board: laneOf(s).board,
        pending: pendingOf(s),
        out: s.out,
        place: s.place,
        winner: s.place === 1,
        popups: s.popups,
        hitAt: s.hitAt,
        landAt: s.landAt,
      },
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
  $("own").hidden = !app.lane;
  if (key === app.boardsKey) {
    for (const s of app.seats) if (s?.el) setText(s.el.querySelector<HTMLElement>(".opp-kos")!, s.kos ? `${s.kos} KO` : "");
    return;
  }
  app.boardsKey = key;
  // The feed sits over our board, or over everyone's when we're watching.
  (app.lane ? $("own") : $("arena")).append($("feed"));
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
  const size = app.round?.size ?? 4;
  const top = arena.getBoundingClientRect().top + window.scrollY;
  const narrow = W < 640;
  const legendH = 26;
  const H = Math.max(260, window.innerHeight - top - (narrow ? 12 : 48));
  const slots = miniSlots();
  const n = slots.length;
  const hasOwn = !!app.lane;
  const OW = ownWidth(size);
  const OH = ownHeight(size);
  const MW = miniWidth(size);
  const MH = miniHeight(size);
  const LABEL = 20;
  const GAP = 12;

  // Biggest tile size that fits every small board in the space given.
  const fit = (w: number, h: number) => {
    let best = 6;
    for (let cols = 1; cols <= Math.max(1, n); cols++) {
      const rows = Math.ceil(n / cols);
      best = Math.max(best, Math.floor(Math.min((w / cols - GAP) / MW, (h / rows - LABEL - GAP) / MH)));
    }
    return best;
  };

  let u = 0;
  let m = fit(W, H);
  if (hasOwn) {
    const ownH = H - legendH;
    if (narrow) {
      // Everyone else in a strip above our board, kept short so our whole board stays on screen.
      const strip = n ? Math.min(H * 0.3, 190) : 0;
      u = Math.floor(Math.min((W - 8) / OW, (ownH - strip - GAP) / OH));
      m = fit(W, Math.max(60, Math.min(strip, H - Math.ceil(u * OH) - legendH - GAP)));
    } else {
      // Shrink our board until the others are a fair size beside it: nearly as big as ours with
      // one opponent, down to about a third with seven.
      const want = n <= 1 ? 0.85 : n <= 3 ? 0.5 : 0.34;
      for (u = Math.floor(Math.min(ownH / OH, 130)); u > 30; u--) {
        m = fit(W - Math.ceil(u * OW) - GAP * 2, H);
        if (!n || m >= u * want) break;
      }
      m = fit(W - Math.ceil(u * OW) - GAP * 2, H);
    }
    own.resize(Math.max(30, u), size);
  }
  arena.classList.toggle("stacked", hasOwn && narrow);

  m = Math.max(6, Math.min(m, hasOwn ? Math.max(30, u) : 90));
  for (const slot of slots) {
    const seat = app.seats[slot]!;
    seat.mini?.resize(m, size);
    if (seat.el) seat.el.style.width = `${Math.round(MW * m)}px`;
  }
  $("opps").classList.toggle("tiny", m < 16);
}

// ------------------------------------------------------------------ game

function renderGame(s: GameState): void {
  const n = app.seats.filter(Boolean).length;
  $("round-label").textContent = app.round ? `Round ${app.round.n} · ${solo() ? "solo" : `${n} players`}` : `Round ${s.round}`;
  renderHud();
  renderScoreboard();
  if (s.phase === "results") {
    if (!app.resultsAt) renderResults(s);
  } else {
    $("results").hidden = true;
  }
}

/**
 * Moves and ops come in faster than frames with a few players (30–40 a second with 8), so they
 * only mark the HUD and scoreboard out of date, and the frame renders them once. Nothing the game
 * needs waits on it: the boards and lanes are already up to date.
 */
function renderSoon(): void {
  app.hudDirty = true;
}

function renderHud(): void {
  const s = shell.state;
  if (!s || shell.screen !== "game") return;
  const mine = me();
  const seat = mySeat();
  const lane = app.lane;
  const left = alive();
  const total = app.seats.filter(Boolean).length;
  let html: string;
  if (!mine || !seat || !lane) {
    html = `<span class="note">Watching${mine?.spectator ? " — you'll get a board next round" : ""}</span>`;
  } else {
    const status = solo()
      ? seat.out
        ? "out of moves"
        : seat.won
          ? "you win! keep going"
          : "solo"
      : seat.place === 1 && app.round?.over
        ? "winner!"
        : seat.out
          ? `out · #${seat.place}`
          : seat.place
            ? `#${seat.place}`
            : app.round?.over
              ? ""
              : "in play";
    html =
      `<span class="chip" style="background:${mine.color}"></span><span>${esc(mine.name)}</span>` +
      (total && !solo() ? `<span class="tag">${left}/${total} left</span>` : "") +
      (status ? `<span class="note">${status}</span>` : "");
  }
  setHtml($("hud-main"), html);
  $("hud").classList.toggle("solo", solo());
  $("screen-game").classList.toggle("solo", solo());
  const goal = solo() ? SOLO_GOAL : (app.round?.goal ?? s.settings.goal);
  const goalEl = $("hud-goal");
  setText(goalEl, goal ? String(goal) : "Survive");
  const title = solo()
    ? `Make a ${SOLO_GOAL} tile to win, then keep going`
    : goal
      ? `First to make a ${goal} tile wins (or be the last one standing)`
      : "Last one standing wins";
  if (goalEl.title !== title) goalEl.title = title;
  setText($("hud-moves"), lane ? String(lane.n) : "—");
  setText($("hud-best"), lane ? tile(lane.best) : "—");
  setText($("hud-score"), lane ? String(lane.score) : "—");
  setText($("hud-sent"), seat ? String(seat.atk) : "—");
  setText($("hud-kos"), seat ? String(seat.kos) : "—");
}

/** The rock multiplier goes up on its own, so it's refreshed every frame. */
function renderClock(): void {
  const r = app.round;
  const scale = r ? attackScale(serverNow() - r.goAt) : 1;
  const x = $("hud-scale");
  const text = `×${scale}`;
  if (x.textContent !== text) {
    x.textContent = text;
    x.classList.toggle("hot", scale > 1);
    x.title = scale > 1 ? `Rocks sent are multiplied by ${scale} to bring the round to an end` : "";
  }
}
function renderScoreboard(): void {
  if (shell.screen !== "game") return;
  const rows = app.seats
    .filter((s): s is SeatView => !!s)
    .sort((a, b) => (a.place || 99) - (b.place || 99) || laneOf(b).best - laneOf(a).best || a.slot - b.slot);
  const html = rows
    .map((seat) => {
      const look = app.looks[seat.slot];
      const lane = laneOf(seat);
      const you = seat.slot === app.mySlot;
      const status = solo() ? "" : seat.place === 1 && app.round?.over ? "winner" : seat.place ? `#${seat.place}` : "";
      const meta = solo() ? `${lane.score} pts · ${lane.n} moves` : `${lane.score} pts · ${seat.atk} sent · ${seat.kos} KO`;
      return `<li class="${you ? "me" : ""} ${seat.out ? "dead" : ""}">
        <span class="chip" style="background:${look?.color ?? "#888"}"></span>
        <span class="pname">${esc(look?.name ?? "?")}${you ? ` <span class="tag tag-you">you</span>` : ""}</span>
        <span class="pct">${status || tile(lane.best)}</span>
        <span class="meta">${meta}</span>
      </li>`;
    })
    .join("");
  setHtml($("scoreboard"), html);
  buildBoards();
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
      sub = !app.lane
        ? ""
        : r.solo
          ? `Make ${SOLO_GOAL}, then keep going`
          : r.goal
            ? `First to ${r.goal} wins`
            : "Last one standing wins";
      sound = `count${n}-${r.n}`;
    } else if (until > -800 && app.lane) {
      big = "GO!";
      sound = `go-${r.n}`;
    }
  }
  if (sound && sound !== app.sounded) {
    app.sounded = sound;
    if (sound.startsWith("go")) sfx.go();
    else sfx.count();
  }
  const el = $("banner");
  el.hidden = !big;
  setHtml(el, big ? `<div class="big">${esc(big)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}` : "");
}

/** The solo player's score against their best on this board size; null for a match, or someone else's round. */
function soloBest(s: GameState): { best: number; prev: number | null; fresh: boolean } | null {
  const r = s.results;
  const x = r?.solo ? r.standings[0] : null;
  if (!r || !x || x.id !== shell.me) return null;
  return personalBest(`best.${s.settings.size}`, `${s.code}:${r.round}`, x.score);
}

function renderResults(s: GameState): void {
  const r = s.results;
  const open = s.phase === "results" && !!r;
  $("results").hidden = !open;
  if (!open || !r) return;
  const pcell = (x: { id: string; name: string; color: string }) =>
    `<span class="pcell"><span class="chip" style="background:${x.color}"></span>${esc(x.name)}${x.id === shell.me ? ` <span class="tag tag-you">you</span>` : ""}</span>`;
  if (r.solo) {
    const x = r.standings[0];
    const made = !!x && 2 ** x.best >= SOLO_GOAL;
    $("results-title").textContent = made ? "You win!" : "Game over";
    const best = soloBest(s);
    const who = x?.id === shell.me ? "You" : `<b style="color:${x?.color}">${esc(x?.name ?? "")}</b>`;
    $("results-winner").innerHTML = !x
      ? "Nobody made it."
      : `${who}${made ? ` made ${SOLO_GOAL}, and` : ""} scored <b>${x.score}</b> with a best tile of ${tile(x.best)}.` +
        (!best
          ? ""
          : best.fresh && best.prev !== null
            ? ` <b class="best">A new personal best!</b>`
            : best.fresh
              ? " That's your best so far."
              : ` Your best is ${best.best}.`);
    $("results-head").innerHTML = `<th></th><th>Player</th><th>Best</th><th>Score</th><th>Moves</th><th>Time</th>`;
    $("results-rows").innerHTML = r.standings
      .map(
        (x) => `<tr class="${made ? "winner" : ""}"><td></td><td>${pcell(x)}</td><td>${tile(x.best)}</td><td>${x.score}</td>
        <td>${x.moves}</td><td>${formatClock(x.secs * 1000)}</td></tr>`,
      )
      .join("");
  } else {
    $("results-title").textContent = `Round ${r.round} results`;
    const winner = r.standings.find((x) => x.id === r.winnerId);
    const you = winner?.id === shell.me;
    const name = winner ? `<b style="color:${winner.color}">${esc(you ? "You" : winner.name)}</b>` : "";
    $("results-winner").innerHTML = !winner
      ? "Nobody made it."
      : r.how === "goal"
        ? `${name} made ${r.goal} first.`
        : `${name} ${you ? "are" : "is"} the last one standing.`;
    $("results-head").innerHTML =
      `<th></th><th>Player</th><th>Best</th><th>Score</th><th>Sent</th><th>Smashed</th><th>KOs</th><th>Time</th><th>Wins</th>`;
    $("results-rows").innerHTML = r.standings
      .map((x) => {
        const p = shell.player(x.id);
        return `<tr class="${x.id === r.winnerId ? "winner" : ""}">
        <td>${x.place}</td>
        <td>${pcell(x)}</td>
        <td>${tile(x.best)}</td><td>${x.score}</td><td>${x.sent}</td><td>${x.smashed}</td><td>${x.kos}</td><td>${formatClock(x.secs * 1000)}</td><td>${p?.wins ?? "—"}</td></tr>`;
      })
      .join("");
  }
  const host = shell.canHost();
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
    : `Waiting for ${shell.player(s.hostId)?.name ?? "the host"} to start the next round…`;
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  window.addEventListener("resize", () => (shell.screen === "home" ? attract.resize() : layoutArena()));
  new ResizeObserver(() => {
    if (shell.screen === "game" && $("arena").clientWidth !== app.arenaWidth) layoutArena();
  }).observe($("arena"));
  const touch = () => {
    $("keys-hint").innerHTML = `Swipe on your board to slide<span class="rock-hint"> · merge next to a rock to smash it</span>`;
  };
  if (window.matchMedia?.("(pointer: coarse)").matches) touch();
  window.addEventListener("touchstart", touch, { once: true, passive: true });
  // Buttons in the game screen give up focus after a click, so arrow keys go to the board.
  $("screen-game").addEventListener("click", (e) => (e.target as HTMLElement).closest("button")?.blur());
}

wire();
shell.start();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __dt: { app, own, shell, tryMove, attract } });
