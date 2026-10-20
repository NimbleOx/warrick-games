import { unlockAudio } from "@warrick/kit/client/audio";
import { $, esc, setHtml, setText, toast } from "@warrick/kit/client/dom";
import { showClock } from "@warrick/kit/client/hud";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { cellNear, centre, step } from "../shared/hex";
import {
  COLORS,
  MAX_SEATS,
  SETTING_CHOICES,
  seated,
  turnLimit,
  type ClientMsg,
  type GameState,
  type PlayerState,
  type ServerMsg,
} from "../shared/protocol";
import { LAYOUT_NAMES, MARBLES, MAX_LINE, TO_WIN, lineOf, shove, type Layout, type Shove } from "../shared/rules";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { BoardView, SPAN_X, SPAN_Y, STEP, type Arrow, type Scene } from "./view";

// ------------------------------------------------------------------ app state

interface Drag {
  pointerId: number;
  /** The marble it started on, and where, in board units. */
  cell: number;
  x0: number;
  y0: number;
  moved: boolean;
}

/** How long a move takes to slide in, and one that pushes a marble off. */
const SLIDE_MS = 220;
const SLIDE_OFF_MS = 480;

const app = {
  /** The marbles you've picked, and the direction under the pointer (or the drag). */
  sel: [] as number[],
  hot: null as number | null,
  drag: null as Drag | null,
  /** Moves already seen, the game they belong to, and when the newest started sliding in. */
  seen: 0,
  gameNo: -1,
  turnKey: "",
  slideAt: 0,
  slideMs: SLIDE_MS,
  sending: false,
  hideResults: false,
  dirty: true,
};

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "shove-off",
  title: "Shove Off",
  prefix: "so",
  logo: "SHOVE<br />OFF",
  tagline: "Push six of their marbles off the board.<br />No accounts — just share a code.",
  placeholder: "Pusher",
  footer: "A love letter to <em>Abalone</em> (1987).",
  playersLabel: "Players",
  rules: [
    "Move 1, 2 or 3 of your marbles in a line, one hole in any direction.",
    "Push their marbles along the line when you have more in it: 2 push 1, 3 push 1 or 2.",
    "Push 6 of theirs off the edge to win. At the move limit, whoever pushed more off wins.",
    "Against a CPU there's no turn timer.",
  ],
  minPlayers: 1,
  soloLabel: "Play the CPU",
  soloRules: [
    "On your own, you play a normal CPU. For an easy or a hard one, use Add CPU.",
    "Move 1, 2 or 3 of your marbles in a line, one hole in any direction.",
    "Push their marbles along the line when you have more in it: 2 push 1, 3 push 1 or 2.",
    "Push 6 of theirs off the edge to win. No turn timer against a CPU.",
  ],
  colors: COLORS,
  maxPlayers: MAX_SEATS,
  settings: {
    layout: { label: "Start", fmt: (v: Layout) => LAYOUT_NAMES[v] },
    turnSeconds: {
      label: "Turn timer",
      fmt: (v: number) => (v ? (v >= 120 ? `${v / 60} minutes` : `${v} seconds`) : "No limit"),
    },
    moveLimit: { label: "Move limit", fmt: (v: number) => (v ? `${v} moves each` : "No limit") },
  },
  choices: SETTING_CHOICES,
  onWelcome: () => {
    app.sending = false;
  },
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s): string | null => (playing(s) ? "Leave this game? You'll lose it." : null),
});
const board = new BoardView($<HTMLCanvasElement>("board"));
const attract = new Attract($<HTMLCanvasElement>("attract"));

const me = (s = shell.state): PlayerState | undefined => s?.players.find((p) => p.id === shell.me);
const mySeat = (s = shell.state): number => me(s)?.seat ?? -1;
/** You have a seat in a game that's on. */
const playing = (s = shell.state): boolean => !!s && s.phase === "playing" && mySeat(s) >= 0;
const isMyTurn = (s = shell.state): boolean => playing(s) && s!.turnPlayerId === shell.me;
/** The second seat sees the board turned round, with its own marbles at the bottom. */
const flipped = (s = shell.state): boolean => mySeat(s) === 1;
const seatColor = (s: GameState, seat: number): string => s.players.find((p) => p.id === s.seats[seat])?.color ?? "#888888";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "game") layoutStage();
  if (screen === "home") attract.resize();
}

/** Left the game, or lost it for good. */
function onReset(): void {
  clearSel();
  app.gameNo = -1;
  app.sending = false;
  $("gameover").hidden = true;
}

function onMessage(msg: ServerMsg): void {
  if (msg.t === "error") {
    // The shell has shown the message.
    app.sending = false;
    sfx.nope();
    render();
  }
}

function onState(s: GameState, prev: GameState | null): void {
  if (s.phase === "lobby") {
    app.gameNo = -1;
    clearSel();
    return;
  }
  board.flip = flipped(s);
  if (s.game !== app.gameNo) {
    // A new game (or we just arrived): nothing slides in.
    const fresh = app.gameNo !== -1 || (prev?.phase === "lobby" && s.moves === 0);
    app.gameNo = s.game;
    app.seen = s.moves;
    app.hideResults = false;
    clearSel();
    if (fresh && s.phase === "playing") {
      const first = shell.player(s.seats[0]);
      banner(first?.id === shell.me ? "YOU MOVE FIRST" : `${esc(first?.name ?? "").toUpperCase()} MOVES FIRST`, "", 1600);
      sfx.start();
    }
  }
  if (s.moves > app.seen) {
    landed(s, s.moves === app.seen + 1);
    app.seen = s.moves;
  }
  // Marbles you'd picked that have been pushed (or moved) aren't yours to move any more.
  if (app.sel.some((c) => s.board[c] !== mySeat(s)) || !playing(s)) clearSel();

  const turnKey = `${s.game}:${s.turns}:${s.turnPlayerId}`;
  if (turnKey !== app.turnKey) {
    app.turnKey = turnKey;
    app.sending = false;
    if (isMyTurn(s)) window.setTimeout(() => isMyTurn() && sfx.yourTurn(), s.moves ? app.slideMs : 0);
  }
  if (s.phase === "gameover" && prev?.phase === "playing") {
    // The happy tune for the winner, and for anyone watching.
    const happy = s.winners.includes(shell.me) || mySeat(s) < 0;
    window.setTimeout(() => sfx.gameOver(happy), app.slideMs);
  }
  document.title = isMyTurn(s) ? "▶ Your turn — Shove Off" : `Shove Off · ${s.code}`;
  render();
}

/** A move landed: slide it in (only if it's the one after what's on screen) and play its sound. */
function landed(s: GameState, slide: boolean): void {
  const last = s.last;
  if (!last) return;
  app.slideMs = last.off >= 0 ? SLIDE_OFF_MS : SLIDE_MS;
  app.slideAt = slide ? performance.now() : 0;
  if (last.off >= 0) {
    sfx.off();
    const pusher = shell.player(s.seats[last.seat]);
    const n = pusher?.pushed ?? 0;
    if (pusher?.id === shell.me) banner("PUSHED OFF!", `${n} of ${TO_WIN}`, 1500);
    else if (last.seat !== mySeat(s) && mySeat(s) >= 0)
      banner("LOST ONE", `${esc(pusher?.name ?? "The other player")} has ${n} of ${TO_WIN}`, 1500);
  } else if (last.pushed.length) sfx.push();
  else sfx.move(last.marbles.length);
}

// ------------------------------------------------------------------ picking and moving

function clearSel(): void {
  app.sel = [];
  app.hot = null;
  app.drag = null;
  app.dirty = true;
}

/** Click a marble of yours: add it to the line, take it off, or start a new line from it. */
function toggle(c: number): void {
  const s = shell.state!;
  const sel = app.sel;
  if (sel.includes(c)) {
    if (sel.length === 1) app.sel = [];
    else {
      const line = lineOf(sel)!.ordered;
      // An end leaves the line; the middle one starts again on its own.
      app.sel = c === line[0] || c === line[line.length - 1] ? sel.filter((x) => x !== c) : [c];
    }
  } else if (sel.length < MAX_LINE && lineOf([...sel, c])) {
    app.sel = [...sel, c];
  } else {
    // Two along from a lone marble: the three in a line, if the one between is yours too.
    app.sel = (sel.length === 1 && between(s, sel[0], c)) || [c];
  }
  app.hot = null;
  sfx.pick();
}

function between(s: GameState, a: number, b: number): number[] | null {
  for (let d = 0; d < 6; d++) {
    const m = step(a, d);
    if (m >= 0 && step(m, d) === b && s.board[m] === mySeat(s)) return [a, m, b];
  }
  return null;
}

/** Each direction's arrow for the picked marbles, legal or not. */
function arrows(s: GameState): Arrow[] {
  const sel = app.sel;
  if (!sel.length || !playing(s)) return [];
  const line = lineOf(sel);
  if (!line) return [];
  const mid = sel.reduce((a, c) => ({ x: a.x + centre(c).x / sel.length, y: a.y + centre(c).y / sel.length }), { x: 0, y: 0 });
  return STEP.map((v, dir) => {
    const along = sel.length === 1 || dir === line.axis || (dir + 3) % 6 === line.axis;
    // Along the line, just past the front marble; a side step, beside the middle of the line.
    const k = along ? (sel.length + 1) / 2 : 1;
    return { dir, x: mid.x + v.x * k, y: mid.y + v.y * k, ok: typeof result(s, dir) !== "string" };
  });
}

/** What moving the picked marbles that way would do, or why it can't. */
function result(s: GameState, dir: number): Shove | string {
  return shove(s.board, mySeat(s), { marbles: app.sel, dir });
}

type Hit = { kind: "marble"; cell: number } | { kind: "arrow"; dir: number } | { kind: "none" };

/** What's under a point on the board (in board units): one of your marbles, an arrow, or neither. */
function hit(s: GameState, p: { x: number; y: number }): Hit {
  const c = cellNear(p.x, p.y);
  const own = c >= 0 && s.board[c] === mySeat(s);
  if (own && Math.hypot(p.x - centre(c).x, p.y - centre(c).y) < 0.46) return { kind: "marble", cell: c };
  let best: Hit = { kind: "none" };
  let d = 0.62;
  for (const a of arrows(s)) {
    const da = Math.hypot(p.x - a.x, p.y - a.y);
    if (da < d) {
      d = da;
      best = { kind: "arrow", dir: a.dir };
    }
  }
  if (best.kind === "none" && own) return { kind: "marble", cell: c };
  return best;
}

let sendWatchdog = 0;

function tryMove(dir: number): void {
  const s = shell.state;
  if (!s || !playing(s) || !app.sel.length || app.sending) return;
  const r = result(s, dir);
  if (typeof r === "string") {
    sfx.nope();
    toast(r);
    return;
  }
  if (!isMyTurn(s)) {
    sfx.nope();
    toast(`Wait for your turn: it's ${shell.player(s.turnPlayerId)?.name ?? "someone else"}'s go`, "info");
    return;
  }
  if (!shell.send({ t: "move", move: { marbles: app.sel, dir } })) {
    toast("Not connected — reconnecting, try again in a moment");
    return;
  }
  app.sending = true;
  app.hot = null;
  render();
  // If the server never answers (dropped connection), give the controls back.
  clearTimeout(sendWatchdog);
  sendWatchdog = window.setTimeout(() => {
    if (!app.sending) return;
    app.sending = false;
    render();
    toast("The server didn't answer — try again");
  }, 6000);
}

/** The direction nearest a drag (in board units). */
function dragDir(dx: number, dy: number): number {
  let best = 0;
  let most = -Infinity;
  STEP.forEach((v, d) => {
    const dot = dx * v.x + dy * v.y;
    if (dot > most) {
      most = dot;
      best = d;
    }
  });
  return best;
}

// ------------------------------------------------------------------ drawing

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game") return;
  // Once the slide is over, one more frame draws the move as it landed.
  if (app.slideAt && now - app.slideAt >= app.slideMs) {
    app.slideAt = 0;
    app.dirty = true;
  }
  if (app.dirty || app.slideAt) {
    app.dirty = false;
    draw(now);
  }
  tickClock();
}

function draw(now: number): void {
  const s = shell.state;
  if (!s || !s.board.length) return;
  const seat = mySeat(s);
  const slide = app.slideAt ? (now - app.slideAt) / app.slideMs : null;
  const hot = app.hot !== null && app.sel.length ? result(s, app.hot) : null;
  const scene: Scene = {
    board: s.board,
    colors: [seatColor(s, 0), seatColor(s, 1)],
    flip: flipped(s),
    last: s.last,
    slide,
    selected: app.sel,
    selColor: "#ffd23f",
    arrows: app.sending ? [] : arrows(s),
    hot: app.hot,
    preview: hot && typeof hot !== "string" ? { sh: hot, seat } : null,
    waiting: !isMyTurn(s),
  };
  board.draw(scene);
}

function render(): void {
  app.dirty = true;
  const s = shell.state;
  if (!s || s.phase === "lobby") return;
  renderScores(s);
  renderHint(s);
  renderTools(s);
  renderWatchers(s);
  renderGameOver(s);
}

/** The picked marbles or the arrow under the pointer changed: only the board, the hint and Clear. */
function renderPick(): void {
  app.dirty = true;
  const s = shell.state;
  if (!s || s.phase === "lobby") return;
  renderHint(s);
  renderTools(s);
}

/** Your card on the left (or the first player's, watching), each with the marbles it has pushed off. */
function renderScores(s: GameState): void {
  const players = seated(s);
  if (mySeat(s) === 1) players.reverse();
  const limit = turnLimit(s);
  const moveNo = Math.min(Math.floor(s.turns / 2) + 1, s.settings.moveLimit || Infinity);
  setHtml(
    $("hud-move"),
    s.phase === "playing"
      ? `<span class="label">Move</span> <b>${moveNo}</b>${limit ? `<span class="muted"> of ${s.settings.moveLimit}</span>` : ""}`
      : `<button class="btn btn-small" id="show-results">Results</button>`,
  );
  players.forEach((p, i) => {
    const card = $(`card-${i}`);
    const theirs = seatColor(s, 1 - p.seat);
    const turn = s.phase === "playing" && s.turnPlayerId === p.id;
    card.className = [
      "pcard",
      turn ? "turn" : "",
      s.winners.includes(p.id) ? "won" : "",
      !p.cpu && !p.connected ? "offline" : "",
    ].join(" ");
    const tags = [
      p.id === shell.me ? `<span class="tag tag-you">you</span>` : "",
      p.cpu ? `<span class="tag">CPU · ${p.cpu}</span>` : "",
      !p.cpu && !p.connected ? `<span class="tag">offline</span>` : "",
      s.winners.includes(p.id) ? `<span class="tag tag-host">winner</span>` : "",
    ].join("");
    const status = turn
      ? p.cpu
        ? `<span class="status">thinking…</span>`
        : `<span class="status clock" data-clock></span>`
      : `<span class="status"></span>`;
    const slots = Array.from({ length: TO_WIN }, (_, k) =>
      k < p.pushed ? `<i class="ball" style="--c:${theirs}"></i>` : `<i class="slot"></i>`,
    ).join("");
    setHtml(
      card,
      `<div class="pc-head"><i class="ball" style="--c:${p.color}"></i><span class="pname">${esc(p.name)}</span>${tags}<span class="spacer"></span>${status}</div>
       <div class="pc-off" title="${plural(p.pushed, "marble")} pushed off">${slots}<span class="muted small">${p.pushed}/${TO_WIN}</span></div>`,
    );
  });
  tickClock();
}

function renderHint(s: GameState): void {
  const p = me(s);
  let text = "";
  let tone = "";
  const turn = shell.player(s.turnPlayerId);
  if (s.phase === "gameover") text = "Game over.";
  else if (!p || p.seat < 0)
    text = "You're watching this game. You'll get a seat when the host starts the next one, if there's room.";
  else if (app.sending) text = "Moving…";
  else if (!app.sel.length) {
    text = isMyTurn(s)
      ? "Your turn: pick 1 to 3 of your marbles in a line."
      : `Waiting for ${turn?.name ?? "the other player"}… you can pick marbles to plan meanwhile.`;
  } else {
    const ok = arrows(s).filter((a) => a.ok);
    const r = app.hot !== null ? result(s, app.hot) : null;
    if (typeof r === "string") {
      text = r;
      tone = "bad";
    } else if (r) {
      const what =
        r.off >= 0 ? "That pushes one off!" : r.pushed.length ? `That pushes ${plural(r.pushed.length, "marble")}.` : "";
      text = isMyTurn(s)
        ? `${what} ${app.drag?.moved ? "Let go to move." : "Click to move."}`.trim()
        : `${what} Wait for your turn to move.`.trim();
      tone = isMyTurn(s) ? "good" : "";
    } else if (!ok.length) {
      text =
        app.sel.length === 1
          ? "That marble can't move anywhere. Pick another."
          : "Those can't move anywhere together. Pick others.";
      tone = "bad";
    } else {
      text = touchUi()
        ? "Tap an arrow to move them, or drag them. Tap a marble to add or drop it."
        : "Click an arrow (or drag them) to move. Click marbles to add or drop them; Esc clears.";
    }
  }
  const el = $("hint");
  setText(el, text);
  el.classList.toggle("bad", tone === "bad");
  el.classList.toggle("good", tone === "good");
}

function renderTools(s: GameState): void {
  const resign = $<HTMLButtonElement>("tool-resign");
  resign.hidden = !playing(s);
  $<HTMLButtonElement>("tool-clear").disabled = !app.sel.length;
  board.canvas.classList.toggle("live", playing(s));
}

function renderWatchers(s: GameState): void {
  const watchers = s.players.filter((p) => p.seat < 0);
  const el = $("watchers");
  el.hidden = !watchers.length;
  setHtml(el, watchers.length ? `Watching: ${watchers.map((p) => esc(p.name)).join(", ")}` : "");
}

const ENDINGS: Record<string, (w: string, l: string) => string> = {
  six: (w) => `${w} pushed ${TO_WIN} off.`,
  resigned: (w, l) => `${l} resigned.`,
  left: (w, l) => `${l} left the game.`,
  away: (w, l) => `${l} was away for 3 turns.`,
};

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover" && !app.hideResults;
  $("gameover").hidden = !open;
  if (s.phase !== "gameover") return;
  const players = seated(s);
  const winner = players.find((p) => s.winners.includes(p.id));
  const loser = players.find((p) => p !== winner);
  const name = (p: PlayerState | undefined) => (p ? `<b style="color:${p.color}">${esc(p.name)}</b>` : "");
  const mine = mySeat(s) >= 0;
  $("gameover-title").textContent = !winner
    ? "A draw"
    : winner.id === shell.me
      ? "You win!"
      : mine
        ? "You lose"
        : `${winner.name} wins`;
  let line: string;
  if (!winner) line = `The move limit, with ${plural(players[0]?.pushed ?? 0, "marble")} pushed off each.`;
  else if (s.ending === "limit") line = `The move limit: ${name(winner)} pushed ${winner.pushed} off to ${loser?.pushed ?? 0}.`;
  else line = ENDINGS[s.ending ?? "six"](name(winner), name(loser));
  setHtml($("gameover-winner"), line);
  const rows = [...players]
    .sort((a, b) => Number(s.winners.includes(b.id)) - Number(s.winners.includes(a.id)) || a.seat - b.seat)
    .map(
      (p) => `<tr class="${s.winners.includes(p.id) ? "winner" : ""}">
        <td><span class="pcell"><i class="ball" style="--c:${p.color}"></i>${esc(p.name)}</span></td>
        <td>${p.pushed}</td><td>${MARBLES - (players.find((o) => o !== p)?.pushed ?? 0)}</td></tr>`,
    )
    .join("");
  setHtml($("gameover-rows"), rows);
  const host = shell.canHost(s);
  const again = $<HTMLButtonElement>("gameover-again");
  const back = $<HTMLButtonElement>("gameover-lobby");
  again.hidden = !host;
  back.disabled = !host;
  back.textContent = host ? "Back to lobby" : `Waiting for ${shell.player(s.hostId)?.name ?? "host"}…`;
}

function tickClock(): void {
  const s = shell.state;
  const clock = document.querySelector<HTMLElement>(".pcard [data-clock]");
  if (!s || !clock) return;
  const left = s.turnDeadline && s.phase === "playing" ? Math.max(0, s.turnDeadline - shell.serverNow()) : null;
  showClock(clock, left, 10_000);
}

let bannerTimer = 0;
/** A big word over the board for a moment. Hidden by a timer, so a background tab doesn't keep it. */
function banner(big: string, small: string, ms: number): void {
  const el = $("banner");
  el.innerHTML = `<span class="big">${big}</span>${small}`;
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => (el.hidden = true), ms);
}

// ------------------------------------------------------------------ layout

let lastTouch = false;
const coarse = window.matchMedia("(pointer: coarse)");
function touchUi(): boolean {
  return lastTouch || coarse.matches;
}

function layoutStage(): void {
  const stage = $("stage");
  const narrow = window.innerWidth <= 760;
  // Keep the whole board on screen beside the chat; on phones it takes the width.
  const byHeight = narrow ? Infinity : ((window.innerHeight - 230) * SPAN_X) / SPAN_Y;
  if (board.resize(Math.min(stage.clientWidth, byHeight))) app.dirty = true;
}

// ------------------------------------------------------------------ input

function capture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Not an active pointer any more.
  }
}

function wire(): void {
  window.addEventListener("resize", () => (shell.screen === "home" ? attract.resize() : layoutStage()));
  new ResizeObserver(() => shell.screen === "game" && layoutStage()).observe($("stage"));
  window.addEventListener("pointerdown", (e) => (lastTouch = e.pointerType !== "mouse"), { capture: true, passive: true });

  const canvas = board.canvas;
  canvas.addEventListener("pointerdown", (e) => {
    const s = shell.state;
    if (!s || !playing(s) || e.button > 0) return;
    unlockAudio();
    const p = board.toBoard(e.clientX, e.clientY);
    const h = hit(s, p);
    if (h.kind !== "marble") return;
    capture(canvas, e.pointerId);
    app.drag = { pointerId: e.pointerId, cell: h.cell, x0: p.x, y0: p.y, moved: false };
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    const s = shell.state;
    if (!s || !playing(s)) return;
    const p = board.toBoard(e.clientX, e.clientY);
    const d = app.drag;
    if (d && d.pointerId === e.pointerId) {
      const dx = p.x - d.x0;
      const dy = p.y - d.y0;
      if (!d.moved && Math.hypot(dx, dy) > 0.45) {
        d.moved = true;
        // Dragging a marble you hadn't picked moves it (and the line it makes with the rest, if any).
        if (!app.sel.includes(d.cell)) {
          app.sel = app.sel.length < MAX_LINE && lineOf([...app.sel, d.cell]) ? [...app.sel, d.cell] : [d.cell];
          sfx.pick();
        }
      }
      if (d.moved) {
        const dir = dragDir(dx, dy);
        if (dir !== app.hot) {
          app.hot = dir;
          renderPick();
        }
      }
      return;
    }
    if (e.pointerType !== "mouse") return;
    const h = hit(s, p);
    const hot = h.kind === "arrow" ? h.dir : null;
    if (hot !== app.hot) {
      app.hot = hot;
      renderPick();
    }
    canvas.classList.toggle("pointing", h.kind !== "none");
  });
  canvas.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse" || app.drag) return;
    if (app.hot !== null) {
      app.hot = null;
      renderPick();
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    const s = shell.state;
    if (!s || !playing(s) || e.button > 0) return;
    const d = app.drag;
    app.drag = null;
    if (d && d.pointerId === e.pointerId && d.moved) {
      const dir = app.hot;
      app.hot = null;
      if (dir !== null) tryMove(dir);
      renderPick();
      return;
    }
    const h = hit(s, board.toBoard(e.clientX, e.clientY));
    if (h.kind === "marble") toggle(h.cell);
    else if (h.kind === "arrow") tryMove(h.dir);
    else if (app.sel.length) clearSel();
    // A finger leaves nothing under the pointer.
    if (e.pointerType !== "mouse") app.hot = null;
    renderPick();
  });
  canvas.addEventListener("pointercancel", () => {
    app.drag = null;
    app.hot = null;
    renderPick();
  });

  const tool = (id: string, fn: () => void) => {
    $(id).addEventListener("click", (e) => {
      fn();
      (e.currentTarget as HTMLElement).blur();
    });
    $(id).addEventListener("mousedown", (e) => e.preventDefault());
  };
  tool("tool-clear", () => {
    clearSel();
    render();
  });
  tool("tool-resign", () => {
    if (playing() && confirm("Resign this game? The other player wins.")) shell.send({ t: "resign" });
  });
  tool("gameover-board", () => {
    app.hideResults = true;
    render();
  });
  // Straight into the next game: back to the lobby and start, with the other player moving first.
  tool("gameover-again", () => {
    shell.send({ t: "lobby" });
    shell.send({ t: "start" });
  });
  $("hud-move").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("#show-results")) {
      app.hideResults = false;
      render();
    }
  });

  // W E / A D / Z X: the six directions around S, as the board is shown.
  const KEYS: Record<string, number> = { d: 0, e: 1, w: 2, a: 3, z: 4, x: 5 };
  window.addEventListener("keydown", (e) => {
    if (shell.screen !== "game" || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, select, textarea")) return;
    // A focused button handles its own Space/Enter.
    if ((e.key === " " || e.key === "Enter") && target.closest("button")) return;
    if (e.key === "Escape") {
      if (!app.sel.length) return;
      clearSel();
      render();
      e.preventDefault();
      return;
    }
    const k = KEYS[e.key.toLowerCase()];
    if (k === undefined || !app.sel.length || !playing()) return;
    e.preventDefault();
    tryMove(flipped() ? (k + 3) % 6 : k);
  });
}

wire();
shell.start();
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  Object.assign(window, {
    __so: {
      app,
      shell,
      attract,
      /** Dev aid: move one of your marbles, the first one that can go somewhere. */
      auto() {
        const s = shell.state;
        if (!s || !isMyTurn(s)) return false;
        const seat = mySeat(s);
        let pick: { marbles: number[]; dir: number } | null = null;
        for (let c = 0; c < s.board.length && !pick; c++) {
          if (s.board[c] !== seat) continue;
          for (let dir = 0; dir < 6 && !pick; dir++) {
            if (typeof shove(s.board, seat, { marbles: [c], dir }) !== "string") pick = { marbles: [c], dir };
          }
        }
        if (pick) shell.send({ t: "move", move: pick });
        return !!pick;
      },
    },
  });
}
