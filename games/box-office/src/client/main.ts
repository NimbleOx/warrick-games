import { $, esc, toast } from "@warrick/kit/client/dom";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { NONE, boardSize, boxCounts, boxesLeft, cloneBoard, geometry, type Board } from "../shared/board";
import { capturable, takeAll } from "../shared/chains";
import { SETTING_CHOICES, standings, type BoardSize, type ClientMsg, type GameState, type ServerMsg } from "../shared/protocol";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { BoardView, SETTLE_MS } from "./render";

const SIZE_NAMES: Record<BoardSize, string> = { small: "Small", medium: "Medium", large: "Large" };
/** Boxes smaller than this (CSS px) take two taps on a touch screen: one to preview, one to draw. */
const FINGER = 48;

// ------------------------------------------------------------------ app state

const app = {
  /** The board as drawn: it catches up with the server's, one line at a time. */
  view: null as Board | null,
  game: -1,
  /** The lines the view has or has queued, in order; how many it shows; the ones still to animate. */
  known: [] as number[],
  shown: 0,
  queue: [] as number[],
  nextAt: 0,
  run: 0,
  lineTime: [] as number[],
  boxTime: [] as number[],
  hover: -1,
  /** Touch: a line waiting for a second tap. */
  preview: -1,
  /** A line sent to the server and not yet in a state. */
  pending: -1,
  myTurn: false,
  bannerUntil: 0,
  resultsAt: 0,
  /** The player closed the results to look at the board. */
  resultsClosed: false,
  pointer: null as { id: number; touch: boolean } | null,
  /** Boxes the player to move can complete in the latest state. */
  caps: [] as number[],
  /** The board needs drawing again; until when something on it is still moving; it was last frame. */
  dirty: true,
  settleUntil: 0,
  moving: false,
};

/** Something the board shows changed: draw it on the next frame. */
function redraw(): void {
  app.dirty = true;
}

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "box-office",
  title: "Box Office",
  prefix: "bo",
  logo: "BOX<br />OFFICE",
  tagline: "Dots and boxes for up to 8 friends.<br />No accounts — just share a code.",
  placeholder: "Ticket holder",
  footer: "After the pencil-and-paper classic <em>Dots and Boxes</em>.",
  rules: [
    "Draw one line a turn between two neighbouring dots.",
    "Close a box to claim it, then go again.",
    "Most boxes wins. Ties share the win.",
    "The board grows with the number of players.",
  ],
  settings: {
    size: { label: "Board", fmt: (v: BoardSize) => SIZE_NAMES[v] ?? v },
    turnSeconds: { label: "Turn timer", fmt: (v: number) => (v ? `${v} seconds` : "No limit") },
  },
  choices: SETTING_CHOICES,
  onWelcome: () => {
    // A fresh snapshot: show it as it is, without replaying anything.
    app.game = -1;
  },
  onMessage: (msg) => {
    if (msg.t === "error") {
      app.pending = -1;
      sfx.nope();
      redraw();
    }
  },
  onState,
  onScreen,
  onReset,
  confirmLeave: (s) =>
    s.phase === "playing" && s.seats.includes(shell.me) ? "Leave this game? The game will play your turns for you." : null,
});
const view = new BoardView($<HTMLCanvasElement>("board"));
const attract = new Attract($<HTMLCanvasElement>("attract"));

const mySeat = (s = shell.state) => (s ? s.seats.indexOf(shell.me) : -1);
const isMyTurn = (s = shell.state) => !!s && s.phase === "playing" && s.turn >= 0 && s.seats[s.turn] === shell.me;
const canDraw = () => isMyTurn() && app.pending < 0;
const seatPlayer = (s: GameState, seat: number) => shell.player(s.seats[seat]);

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "game") layout();
  if (screen === "home") attract.resize();
}

function onReset(): void {
  app.view = null;
  app.game = -1;
  app.known = [];
  app.queue = [];
  app.pending = app.preview = app.hover = -1;
  app.caps = [];
  $("results").hidden = true;
}

function onState(s: GameState, prev: GameState | null): void {
  if (s.phase === "lobby") {
    renderSizeHint(s);
    return;
  }
  sync(s);
  app.caps = capturable(s);
  redraw();
  if (app.pending >= 0 && (s.lines[app.pending] !== NONE || !isMyTurn(s))) app.pending = -1;
  if (!isMyTurn(s)) app.preview = app.hover = -1;
  else if (app.preview >= 0 && s.lines[app.preview] !== NONE) app.preview = -1;

  const mine = isMyTurn(s);
  if (mine && !app.myTurn) {
    sfx.turn();
    flashBanner("YOUR TURN", 1100);
  }
  app.myTurn = mine;
  if (mine) document.title = "▶ Your turn — Box Office";

  if (s.phase === "results" && prev?.phase !== "results") {
    app.resultsAt = 0;
    app.resultsClosed = false;
  }
  if (s.phase !== "results") $("results").hidden = true;
  render(s);
}

/** Catch the drawn board up with the state: animate new lines, or snap to a new game. */
function sync(s: GameState): void {
  const v = app.view;
  const known = app.known;
  // A tab in the background doesn't animate: it catches up in one go.
  const fresh =
    !v ||
    document.hidden ||
    app.game !== s.game ||
    v.w !== s.w ||
    v.h !== s.h ||
    s.order.length < known.length ||
    known.some((e, i) => s.order[i] !== e);
  app.known = s.order.slice();
  if (!fresh) {
    app.queue.push(...s.order.slice(known.length));
    return;
  }
  const sizeChanged = !v || v.w !== s.w || v.h !== s.h;
  app.view = cloneBoard(s);
  app.game = s.game;
  app.shown = s.order.length;
  app.queue = [];
  app.lineTime = [];
  app.boxTime = [];
  app.run = 0;
  if (sizeChanged) layout();
}

function step(now: number): void {
  const s = shell.state;
  const v = app.view;
  if (!s || !v) return;
  while (app.queue.length && now >= app.nextAt) {
    const e = app.queue.shift()!;
    app.shown++;
    v.lines[e] = s.lines[e];
    app.lineTime[e] = now;
    let claimed = 0;
    for (const b of geometry(v.w, v.h).edgeBoxes[e]) {
      if (v.boxes[b] !== NONE) continue;
      if (geometry(v.w, v.h).boxEdges[b].every((x) => v.lines[x] !== NONE)) {
        v.boxes[b] = s.boxes[b];
        app.boxTime[b] = now;
        claimed++;
      }
    }
    app.run = claimed ? app.run + claimed : 0;
    if (claimed) sfx.box(app.run);
    else sfx.line();
    app.settleUntil = now + SETTLE_MS;
    redraw();
    // A long run plays faster, so chains don't drag.
    const left = app.queue.length;
    app.nextAt = now + (left > 8 ? 45 : left > 3 ? 80 : 140);
    renderScores(s);
    if (!app.queue.length && s.phase === "results") sfx.win();
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
  const s = shell.state;
  if (!s || !app.view) return;
  step(now);
  const mine = isMyTurn(s) && !app.queue.length;
  const pulse = mine ? app.caps : [];
  // Idle, nothing moves: the last drawing still stands. Pulsing boxes and a preview line throb.
  // Once they stop, one more frame draws where they ended, however late it comes.
  const moving = now < app.settleUntil || pulse.length > 0 || (mine && app.preview >= 0);
  if (app.dirty || moving || app.moving) {
    app.dirty = false;
    draw(s, app.view, mine, pulse, now);
  }
  app.moving = moving;
  tick(s, now);
}

function draw(s: GameState, board: Board, mine: boolean, pulse: number[], now: number): void {
  const me = mySeat(s);
  const color = (me >= 0 ? seatPlayer(s, me)?.color : undefined) ?? "#ffffff";
  view.draw(
    board,
    {
      colors: s.seats.map((id) => shell.player(id)?.color ?? "#888"),
      labels: initials(s),
      hover: mine ? (app.preview >= 0 ? app.preview : app.hover) : -1,
      hoverColor: color,
      preview: app.preview >= 0,
      pending: app.pending,
      last: app.shown ? s.order[app.shown - 1] : -1,
      pulse,
      lineTime: app.lineTime,
      boxTime: app.boxTime,
    },
    now,
  );
}

function tick(s: GameState, now: number): void {
  const clock = document.querySelector<HTMLElement>("#hud-turn .clock");
  if (clock) {
    const left = s.turnDeadline && s.phase === "playing" ? Math.max(0, s.turnDeadline - shell.serverNow()) : null;
    const text = left === null ? "" : `${Math.ceil(left / 1000)}s`;
    if (clock.textContent !== text) clock.textContent = text;
    clock.classList.toggle("low", left !== null && left < 5000);
  }
  if (app.bannerUntil && now > app.bannerUntil) {
    app.bannerUntil = 0;
    $("banner").hidden = true;
  }
  // The results open once the last lines have played.
  if (s.phase === "results" && !app.queue.length && !app.resultsClosed && $("results").hidden) {
    app.resultsAt ||= now + 900;
    if (now >= app.resultsAt) renderResults(s);
  }
}

// ------------------------------------------------------------------ rendering

function render(s: GameState): void {
  renderHud(s);
  renderScores(s);
  renderActions(s);
  if (s.phase === "results" && !$("results").hidden) renderResults(s);
}

function renderHud(s: GameState): void {
  let who = "";
  if (s.phase === "playing") {
    const p = seatPlayer(s, s.turn);
    const label = isMyTurn(s)
      ? "Your turn"
      : `${esc(p?.name ?? "?")}'s turn${p?.cpu ? `<span class="aside"> (thinking…)</span>` : ""}`;
    who = `<span class="chip" style="background:${p?.color ?? "#888"}"></span><span class="who">${label}</span>`;
  } else if (s.phase === "results") {
    who = `<span class="who">Game over</span>`;
  }
  const html = `${who}<span class="clock"></span>`;
  const el = $("hud-turn");
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
  $("hud-left").innerHTML =
    s.phase === "playing" ? `<span class="aside">${s.w} × ${s.h} · </span>${boxesLeft(s)} left` : `${s.w} × ${s.h}`;
}

function renderScores(s: GameState): void {
  const counts = app.view ? boxCounts(app.view, s.seats.length) : boxCounts(s, s.seats.length);
  const labels = initials(s);
  const html = s.seats
    .map((id, seat) => {
      const p = shell.player(id);
      const cls = [
        s.phase === "playing" && s.turn === seat ? "turn" : "",
        id === shell.me ? "you" : "",
        p && !p.cpu && !p.connected ? "offline" : "",
      ].join(" ");
      const title = `${p?.name ?? "?"}${p?.cpu ? ` (CPU, ${p.cpu})` : ""}${p && !p.cpu && !p.connected ? " (away)" : ""}`;
      return `<li class="${cls}" title="${esc(title)}">
        <span class="chip" style="background:${p?.color ?? "#888"}">${esc(labels[seat])}</span>
        <span class="pname">${esc(p?.name ?? "?")}</span><b>${counts[seat]}</b></li>`;
    })
    .join("");
  const el = $("scores");
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
  el.classList.toggle("crowded", s.seats.length > 4);
}

function renderActions(s: GameState): void {
  const mine = isMyTurn(s);
  const caps = mine ? app.caps : [];
  const take = $<HTMLButtonElement>("take-all");
  take.hidden = !caps.length;
  if (caps.length) take.textContent = `Take all (${takeAll(cloneBoard(s), 0).taken.length})`;
  $("show-results").hidden = !(s.phase === "results" && app.resultsClosed);

  let hint = "";
  const me = mySeat(s);
  if (s.phase === "results") hint = "Game over.";
  else if (me < 0) hint = "You're watching. You'll get a seat in the next game.";
  else if (mine) {
    if (app.preview >= 0) hint = "Tap the line again to draw it.";
    else if (justScored(s, me)) hint = "You closed a box. Go again!";
    else if (caps.length) hint = "You can close a box: draw its last side.";
    else hint = "Your turn: draw a line between two dots.";
  } else {
    const p = seatPlayer(s, s.turn);
    hint =
      p && !p.cpu && !p.connected
        ? `${esc(p.name)} is away. The game will move for them.`
        : `Waiting for ${esc(p?.name ?? "?")}…`;
  }
  const el = $("hint");
  if (el.innerHTML !== hint) el.innerHTML = hint;
}

/** The last line drawn was this seat's and it claimed a box. */
function justScored(s: GameState, seat: number): boolean {
  const last = s.order.at(-1);
  if (last === undefined || s.lines[last] !== seat) return false;
  return geometry(s.w, s.h).edgeBoxes[last].some((b) => s.boxes[b] === seat);
}

function renderResults(s: GameState): void {
  const rows = standings(s);
  const winners = rows.filter((r) => r.place === 1);
  const names = winners.map((r) => `<b style="color:${r.player?.color ?? "inherit"}">${esc(r.player?.name ?? "?")}</b>`);
  const n = winners[0]?.boxes ?? 0;
  const boxes = `${n} box${n === 1 ? "" : "es"}`;
  $("results-winner").innerHTML =
    names.length === 1
      ? `${names[0]} wins with ${boxes}.`
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} share the win with ${boxes} each.`;
  $("results-rows").innerHTML = rows
    .map(
      (r) => `<tr class="${r.place === 1 ? "winner" : ""}">
        <td>${r.place}</td>
        <td><span class="pcell"><span class="chip" style="background:${r.player?.color ?? "#888"}"></span>${esc(r.player?.name ?? "?")}${r.id === shell.me ? ` <span class="tag tag-you">you</span>` : ""}</span></td>
        <td>${r.boxes}</td></tr>`,
    )
    .join("");
  const host = shell.canHost(s);
  $("results-again").hidden = !host;
  $("results-lobby").hidden = !host;
  $("results-wait").textContent = host ? "" : `Waiting for ${shell.player(s.hostId)?.name ?? "the host"}…`;
  $("results").hidden = false;
}

function renderSizeHint(s: GameState): void {
  let el = document.getElementById("size-hint");
  if (!el) {
    $("lobby-settings").insertAdjacentHTML("afterend", `<p class="hint size-hint" id="size-hint"></p>`);
    el = $("size-hint");
  }
  const n = Math.max(2, s.players.filter((p) => !p.spectator).length);
  const { w, h } = boardSize(s.settings.size, n);
  el.textContent = `With ${n} players: ${w} × ${h} boxes. The board grows as players join.`;
}

function flashBanner(text: string, ms: number): void {
  const el = $("banner");
  el.textContent = text;
  el.hidden = false;
  app.bannerUntil = performance.now() + ms;
}

/** Each seat's initial; two letters where players share one. CPUs go by their own name. */
function initials(s: GameState): string[] {
  const names = s.seats.map((id) => (shell.player(id)?.name ?? "?").replace(/^CPU\s+/, ""));
  const first = names.map((n) => (Array.from(n)[0] ?? "?").toUpperCase());
  return names.map((n, i) => (first.filter((f) => f === first[i]).length > 1 ? first[i] + (Array.from(n)[1] ?? "") : first[i]));
}

// ------------------------------------------------------------------ input

function send(edge: number): void {
  if (!canDraw()) return;
  if (!shell.send({ t: "line", edge })) {
    toast("Not connected. Reconnecting, try again in a moment");
    return;
  }
  app.pending = edge;
  app.preview = app.hover = -1;
  redraw();
  window.setTimeout(() => {
    if (app.pending !== edge) return;
    app.pending = -1;
    redraw();
  }, 5000);
  if (shell.state) renderActions(shell.state);
}

function setHover(edge: number): void {
  if (app.hover === edge) return;
  app.hover = edge;
  redraw();
}

/** Why you can't draw right now, said out loud. */
function explain(): void {
  const s = shell.state;
  if (!s || s.phase !== "playing") return;
  if (mySeat(s) < 0) toast("You're watching this game", "info");
  else if (!isMyTurn(s)) toast(`It's ${seatPlayer(s, s.turn)?.name ?? "someone else"}'s turn`, "info");
}

function wireInput(): void {
  const canvas = view.canvas;
  canvas.addEventListener("pointermove", (e) => {
    const s = shell.state;
    if (!s || !app.view) return;
    if (e.pointerType === "mouse" || app.pointer?.id === e.pointerId) {
      setHover(canDraw() ? (view.nearest(s, e.clientX, e.clientY)?.edge ?? -1) : -1);
    }
  });
  canvas.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") setHover(-1);
  });
  canvas.addEventListener("pointerdown", (e) => {
    const s = shell.state;
    if (!s) return;
    app.pointer = { id: e.pointerId, touch: e.pointerType !== "mouse" };
    if (canDraw()) setHover(view.nearest(s, e.clientX, e.clientY)?.edge ?? -1);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone.
    }
  });
  canvas.addEventListener("pointercancel", () => {
    app.pointer = null;
    setHover(-1);
  });
  canvas.addEventListener("pointerup", (e) => {
    const s = shell.state;
    const ptr = app.pointer;
    app.pointer = null;
    if (!s || !ptr || ptr.id !== e.pointerId) return;
    if (!canDraw()) {
      explain();
      return;
    }
    const hit = view.nearest(s, e.clientX, e.clientY);
    if (!hit) {
      app.preview = -1;
      if (ptr.touch) app.hover = -1;
      redraw();
      renderActions(s);
      return;
    }
    // Small boxes on a touch screen, or a tap far from any line: preview first.
    const twoTaps = ptr.touch && (view.cell < FINGER || hit.dist > 0.3);
    if (twoTaps && app.preview !== hit.edge) {
      app.preview = hit.edge;
      redraw();
      renderActions(s);
      return;
    }
    send(hit.edge);
    if (ptr.touch) setHover(-1);
  });

  $("take-all").addEventListener("click", (e) => {
    (e.currentTarget as HTMLElement).blur();
    if (canDraw()) shell.send({ t: "takeAll" });
  });
  $("results-board").addEventListener("click", () => {
    app.resultsClosed = true;
    $("results").hidden = true;
    if (shell.state) renderActions(shell.state);
  });
  $("show-results").addEventListener("click", (e) => {
    (e.currentTarget as HTMLElement).blur();
    app.resultsClosed = false;
    if (shell.state) {
      renderResults(shell.state);
      renderActions(shell.state);
    }
  });
  window.addEventListener("keydown", (e) => {
    if (shell.screen !== "game") return;
    if ((e.target as HTMLElement).closest("input, select, textarea, button")) return;
    if (e.key === "Escape") {
      app.preview = -1;
      redraw();
      if (shell.state) renderActions(shell.state);
    } else if ((e.key === "t" || e.key === "T") && canDraw() && app.caps.length) {
      shell.send({ t: "takeAll" });
    }
  });
}

// ------------------------------------------------------------------ layout

/** Fit the board to the space under the scores and above the actions. */
function layout(): void {
  const s = shell.state;
  const v = app.view;
  if (shell.screen !== "game" || !s || !v || !v.w) return;
  const col = document.querySelector<HTMLElement>(".stage-col")!;
  const stage = $("stage");
  const actions = document.querySelector<HTMLElement>(".actions")!;
  const top = stage.getBoundingClientRect().top + window.scrollY;
  const availW = col.clientWidth - 4;
  const availH = Math.max(240, window.innerHeight - top - actions.offsetHeight - 30);
  view.fit(v.w, v.h, availW, availH);
  redraw();
}

let resizeQueued = false;
function queueLayout(): void {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    if (shell.screen === "home") attract.resize();
    else layout();
  });
}

// ------------------------------------------------------------------ start

window.addEventListener("resize", queueLayout);
new ResizeObserver(queueLayout).observe($("scores"));
new ResizeObserver(queueLayout).observe(document.querySelector<HTMLElement>(".stage-col")!);
wireInput();
shell.start();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __bo: { app, view, shell } });
