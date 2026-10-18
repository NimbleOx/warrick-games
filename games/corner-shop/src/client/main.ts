import { unlockAudio } from "@warrick/kit/client/audio";
import { $, esc, toast } from "@warrick/kit/client/dom";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { PIECE_IDS, flipT, orientFor, orientations, pieceDef, pieceSize, rotateT, type PieceId } from "../shared/pieces";
import {
  COLORS,
  MAX_SEATS,
  SETTING_CHOICES,
  positionOf,
  rankPlayers,
  seated,
  type ClientMsg,
  type GameState,
  type PlayerState,
  type ServerMsg,
} from "../shared/protocol";
import { eachMove, isFirstMove, moveCells, placementError, squaresLeft, type Move, type Position } from "../shared/rules";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { BoardView, type BoardScene } from "./board";
import { HOME_T, pieceSvg } from "./shapes";

// ------------------------------------------------------------------ app state

interface Drag {
  /** From the tray onto the board, or moving the ghost on the board (touch). */
  kind: "tray" | "board";
  pointerId: number;
  touch: boolean;
  x0: number;
  y0: number;
  /** The ghost where the drag began, for relative board drags. */
  gx: number;
  gy: number;
  moved: boolean;
  /** The piece was already in hand when the drag began (a tap puts it back). */
  wasHeld: boolean;
}

const app = {
  /** The piece in your hand, its transform (rotation + flip), and where its ghost is. */
  held: null as PieceId | null,
  t: 0,
  ghost: null as { x: number; y: number } | null,
  /** Where the mouse is over the board, in squares. */
  pointer: null as { x: number; y: number } | null,
  drag: null as Drag | null,
  /** The rules' view of the board, and what you can still do on it. */
  pos: null as Position | null,
  posKey: "",
  fits: new Set<PieceId>(),
  corners: new Set<number>(),
  cornersFor: new Map<PieceId, Set<number>>(),
  /** Moves already seen (for the landing flash and sound), the game they belong to, the turn. */
  seen: 0,
  gameNo: -1,
  turnKey: "",
  flash: null as { cells: number[]; at: number } | null,
  bannerUntil: 0,
  placing: false,
  hideResults: false,
  dirty: true,
};

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "corner-shop",
  title: "Corner Shop",
  prefix: "cs",
  logo: "CORNER<br />SHOP",
  tagline: "Fit your pieces in, corner to corner.<br />No accounts — just share a code.",
  placeholder: "Shopkeeper",
  footer: "A love letter to <em>Blokus</em> (2000).",
  rules: [
    "2 players get a 14×14 board; 3–4 get 20×20, one corner each.",
    "Your first piece covers your starting square. After that, your own pieces may touch only at the corners.",
    "No move left? You're passed. The game ends when nobody can move.",
    "−1 for each square left in your tray; +15 for placing all 21 pieces, +5 more if the monomino goes last.",
  ],
  colors: COLORS,
  maxPlayers: MAX_SEATS,
  settings: {
    turnSeconds: { label: "Turn timer", fmt: (v: number) => (v ? `${v} seconds` : "No limit") },
  },
  choices: SETTING_CHOICES,
  onWelcome: () => {
    app.placing = false;
  },
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s): string | null => {
    const p = me(s);
    return s.phase === "playing" && p && p.seat >= 0 && !p.out ? "Leave this game? You'll be out, and your pieces stay on the board." : null;
  },
});
const board = new BoardView($<HTMLCanvasElement>("board"));
const attract = new Attract($<HTMLCanvasElement>("attract"));

const me = (s = shell.state): PlayerState | undefined => s?.players.find((p) => p.id === shell.me);
/** You have a seat and are still taking turns. */
const playing = (s = shell.state): boolean => !!s && s.phase === "playing" && (me(s)?.seat ?? -1) >= 0 && !me(s)!.out;
const isMyTurn = (s = shell.state): boolean => playing(s) && s!.turnPlayerId === shell.me;
const seatColor = (s: GameState, seat: number): string => s.players.find((p) => p.id === s.seats[seat])?.color ?? "#888";
const seatOut = (s: GameState, seat: number): boolean => !!s.players.find((p) => p.id === s.seats[seat])?.out;

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "game") layoutStage();
  if (screen === "home") attract.resize();
}

/** Left the game, or lost it for good. */
function onReset(): void {
  drop();
  app.pos = null;
  app.posKey = "";
  app.gameNo = -1;
  app.flash = null;
  $("gameover").hidden = true;
}

function onMessage(msg: ServerMsg): void {
  if (msg.t === "error") {
    // The shell has shown the message.
    app.placing = false;
    sfx.nope();
    render();
  }
}

function onState(s: GameState, prev: GameState | null): void {
  if (s.phase === "lobby") {
    app.gameNo = -1;
    drop();
    return;
  }
  const mine = me(s);
  if (s.game !== app.gameNo) {
    // A new game (or we just arrived): no flash for what's already on the board.
    app.gameNo = s.game;
    app.seen = s.moves.length;
    app.hideResults = false;
    drop();
  }
  if (s.moves.length > app.seen) {
    const last = s.moves[s.moves.length - 1];
    app.flash = { cells: last.cells, at: performance.now() };
    if (last.seat === mine?.seat) sfx.place(last.cells.length);
    else sfx.other();
    app.seen = s.moves.length;
  }
  analyse(s);
  if (app.held && !mine?.tray.includes(app.held)) {
    app.placing = false;
    drop();
  }
  if (!playing(s)) drop();

  const turnKey = `${s.game}:${s.moves.length}:${s.turnPlayerId}`;
  if (turnKey !== app.turnKey) {
    app.turnKey = turnKey;
    app.placing = false;
    if (isMyTurn(s)) {
      sfx.yourTurn();
      flashBanner(`<span class="big">YOUR TURN</span>`, 1200);
    } else if (s.phase === "playing" && prev?.phase === "playing") sfx.turn();
  }
  const wasOut = me(prev ?? undefined)?.out;
  if (mine?.out && !wasOut && prev?.phase === "playing") {
    if (mine.out === "stuck") {
      sfx.out();
      flashBanner(`<span class="big">NO MOVES LEFT</span>You're passed for the rest of the game`, 2600);
    } else if (mine.out === "done") flashBanner(`<span class="big">ALL 21 PLACED!</span>`, 2600);
  }
  if (s.phase === "gameover" && prev?.phase === "playing") sfx.gameOver(s.winners.includes(shell.me));
  document.title = isMyTurn(s) ? "▶ Your turn — Corner Shop" : `Corner Shop · ${s.code}`;
  render();
}

/** What you can still do on this board: the pieces that fit and your open corners. */
function analyse(s: GameState): void {
  // Someone going out frees their start, so that changes it too.
  const outs = s.seats.map((_, seat) => (seatOut(s, seat) ? 1 : 0)).join("");
  const key = `${s.game}:${s.moves.length}:${outs}:${shell.me}`;
  if (key === app.posKey && app.pos) return;
  app.posKey = key;
  app.pos = s.size ? positionOf(s) : null;
  app.fits = new Set();
  app.corners = new Set();
  app.cornersFor = new Map();
  const p = me(s);
  if (!app.pos || !p || p.seat < 0 || p.out) return;
  const anchors = new Set<number>();
  eachMove(app.pos, p.seat, (m, a) => {
    anchors.add(a);
    app.fits.add(m.piece);
    let set = app.cornersFor.get(m.piece);
    if (!set) app.cornersFor.set(m.piece, (set = new Set()));
    // A placement can use more than one open corner.
    for (const c of moveCells(app.pos!.size, m)!) set.add(c);
  });
  app.corners = anchors;
  for (const [piece, cells] of app.cornersFor) {
    app.cornersFor.set(piece, new Set([...cells].filter((c) => anchors.has(c))));
  }
}

// ------------------------------------------------------------------ the piece in hand

function orient(): number {
  return orientFor(app.held!, app.t);
}

function heldShape() {
  return orientations(app.held!)[orient()];
}

function ghostMove(): Move | null {
  if (!app.held || !app.ghost) return null;
  return { piece: app.held, orient: orient(), x: app.ghost.x, y: app.ghost.y };
}

/** Is the ghost's spot legal, and if not, why not. */
function ghostCheck(): { cells: number[]; error: string | null } | null {
  const s = shell.state;
  const m = ghostMove();
  const p = me(s);
  if (!s || !m || !app.pos || !p || p.seat < 0) return null;
  const cells = moveCells(s.size, m);
  if (!cells) return null;
  return { cells, error: placementError(app.pos, p.seat, m) };
}

function clampGhost(x: number, y: number): { x: number; y: number } {
  const o = heldShape();
  const size = shell.state?.size ?? 20;
  return { x: Math.max(0, Math.min(size - o.w, x)), y: Math.max(0, Math.min(size - o.h, y)) };
}

/** Put the ghost's middle on a square. True if it moved. */
function centreGhostOn(fx: number, fy: number): boolean {
  const o = heldShape();
  return moveGhost(clampGhost(Math.floor(fx) - Math.floor((o.w - 1) / 2), Math.floor(fy) - Math.floor((o.h - 1) / 2)));
}

/** True if that's somewhere new. */
function moveGhost(to: { x: number; y: number }): boolean {
  const was = app.ghost;
  app.ghost = to;
  return !was || was.x !== to.x || was.y !== to.y;
}

function ghostCentre(): { x: number; y: number } | null {
  if (!app.ghost || !app.held) return null;
  const o = heldShape();
  return { x: app.ghost.x + (o.w - 1) / 2 + 0.5, y: app.ghost.y + (o.h - 1) / 2 + 0.5 };
}

function pick(id: PieceId): void {
  const s = shell.state;
  const p = me(s);
  if (!s || !playing(s) || !p?.tray.includes(id)) return;
  unlockAudio();
  const before = ghostCentre();
  app.held = id;
  app.t = HOME_T[id];
  sfx.pick();
  if (app.pointer) centreGhostOn(app.pointer.x, app.pointer.y);
  else snapGhost(before);
  render();
}

/**
 * Without a mouse over the board, put the piece somewhere it fits: as near as possible to where
 * the last ghost was (or your last piece, or your start), turning it if it must.
 */
function snapGhost(near: { x: number; y: number } | null): void {
  const s = shell.state!;
  const p = me(s)!;
  if (!near) {
    const mine = s.moves.filter((m) => m.seat === p.seat);
    const c = mine.length ? mine[mine.length - 1].cells[0] : s.starts[p.seat];
    near = { x: (c % s.size) + 0.5, y: Math.floor(c / s.size) + 0.5 };
  }
  const best = { m: null as Move | null, d: Infinity };
  if (app.pos && app.fits.has(app.held!)) {
    const want = orient();
    const at = near;
    eachMove(
      app.pos,
      p.seat,
      (m) => {
        const o = orientations(m.piece)[m.orient];
        const d = Math.hypot(m.x + o.w / 2 - at.x, m.y + o.h / 2 - at.y) + (m.orient === want ? 0 : 3);
        if (d < best.d) {
          best.d = d;
          best.m = m;
        }
      },
      [app.held!],
    );
  }
  const m = best.m;
  if (m) {
    if (m.orient !== orient()) app.t = transformFor(m.piece, m.orient, app.t);
    app.ghost = { x: m.x, y: m.y };
  } else {
    centreGhostOn(near.x, near.y);
  }
}

/** A transform giving that orientation, keeping the current flip if it can. */
function transformFor(id: PieceId, o: number, t: number): number {
  const order = [0, 1, 2, 3, 4, 5, 6, 7].sort((a, b) => Number((a & 4) !== (t & 4)) - Number((b & 4) !== (t & 4)));
  return order.find((x) => orientFor(id, x) === o) ?? t;
}

/** Rotate or flip the piece in hand around the middle of its ghost (or the mouse). */
function turnPiece(next: number): void {
  if (!app.held) return;
  const c = ghostCentre();
  app.t = next;
  sfx.pick();
  if (app.pointer) centreGhostOn(app.pointer.x, app.pointer.y);
  else if (c) centreGhostOn(c.x, c.y);
  renderGhost();
}

const rotate = (dir: 1 | -1 = 1) => turnPiece(rotateT(app.t, dir));
const flip = () => turnPiece(flipT(app.t));

function drop(): void {
  app.held = null;
  app.ghost = null;
  app.drag = null;
  app.dirty = true;
}

function nudge(dx: number, dy: number): void {
  if (!app.held || !app.ghost) return;
  app.ghost = clampGhost(app.ghost.x + dx, app.ghost.y + dy);
  app.pointer = null;
  renderGhost();
}

let placeWatchdog = 0;

function place(): void {
  const s = shell.state;
  if (!s || !app.held || app.placing) return;
  const check = ghostCheck();
  if (!check) return;
  if (!isMyTurn(s)) {
    sfx.nope();
    toast(`Wait for your turn: it's ${shell.player(s.turnPlayerId)?.name ?? "someone else"}'s go`, "info");
    return;
  }
  if (check.error) {
    sfx.nope();
    toast(check.error);
    return;
  }
  if (!shell.send({ t: "place", move: ghostMove()! })) {
    toast("Not connected — reconnecting, try again in a moment");
    return;
  }
  app.placing = true;
  render();
  // If the server never answers (dropped connection), give the controls back.
  clearTimeout(placeWatchdog);
  placeWatchdog = window.setTimeout(() => {
    if (!app.placing) return;
    app.placing = false;
    render();
    toast("The server didn't answer — try again");
  }, 6000);
}

// ------------------------------------------------------------------ drawing

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game") return;
  const flashing = app.flash && now - app.flash.at < 700;
  if (app.dirty || flashing) {
    app.dirty = false;
    drawScene(now);
  }
  tickClock();
  if (app.bannerUntil && performance.now() > app.bannerUntil) {
    app.bannerUntil = 0;
    renderBanner();
  }
}

function drawScene(now: number): void {
  const s = shell.state;
  if (!s || !s.size) return;
  const p = me(s);
  const colors = s.seats.map((_, seat) => seatColor(s, seat));
  const scene: BoardScene = {
    size: s.size,
    board: s.board,
    moves: s.moves,
    colors,
    // An out seat's start is free for anyone, so it loses its ring.
    starts: s.starts.map((cell, seat) => ({ cell, color: colors[seat] })).filter((_, seat) => !seatOut(s, seat)),
    showLast: s.moves.length > 0,
    flash: app.flash ? { cells: app.flash.cells, t: (now - app.flash.at) / 700 } : null,
  };
  if (p && playing(s) && app.corners.size) {
    scene.corners = { cells: app.corners, bright: app.held ? (app.cornersFor.get(app.held) ?? new Set()) : null, color: p.color };
  }
  const check = ghostCheck();
  if (check) scene.ghost = { cells: check.cells, ok: !check.error };
  board.draw(scene);
}

function render(): void {
  app.dirty = true;
  const s = shell.state;
  if (!s || s.phase === "lobby") return;
  renderHud(s);
  renderTray(s);
  renderTools(s);
  renderHint(s);
  renderPlayers(s);
  renderBanner();
  renderGameOver(s);
}

/** The piece in hand moved or turned: only the board, the Place button and the hint change. */
function renderGhost(): void {
  app.dirty = true;
  const s = shell.state;
  if (!s || s.phase === "lobby") return;
  renderTools(s);
  renderHint(s);
}

/** Set an element's HTML only when it's different, so hovering and tooltips survive. */
function setHtml(el: HTMLElement, html: string): void {
  if (el.dataset.html === html) return;
  el.innerHTML = html;
  el.dataset.html = html;
}

function renderHud(s: GameState): void {
  const turn = shell.player(s.turnPlayerId);
  let who = "";
  if (s.phase === "playing" && turn) {
    const label = turn.id === shell.me ? "Your turn" : `${esc(turn.name)}'s turn${turn.cpu ? " (thinking…)" : !turn.connected ? " (away)" : ""}`;
    who = `<span class="chip" style="background:${turn.color}"></span><span class="who">${label}</span><span class="clock"></span>`;
  } else if (s.phase === "gameover") {
    who = `<span class="who">Game over</span><button class="btn btn-small" id="show-results">Scores</button>`;
  }
  setHtml($("hud-turn"), who);
  const p = me(s);
  setHtml(
    $("hud-me"),
    p && p.seat >= 0
      ? `<span><span class="label">Score</span> <b>${p.score}</b></span><span><span class="label">Left</span> <b>${p.tray.length}</b></span>`
      : `<span class="muted">Watching</span>`,
  );
}

function renderTray(s: GameState): void {
  const p = me(s);
  const tray = $("tray");
  const seated = !!p && p.seat >= 0;
  const color = p?.color ?? "#888";
  const key = `${s.game}:${color}:${seated}`;
  if (tray.dataset.key !== key) {
    tray.dataset.key = key;
    tray.innerHTML = PIECE_IDS.map(
      (id) =>
        `<button type="button" class="piece" data-piece="${id}" aria-label="${pieceDef(id).name}, ${pieceSize(id)} square${pieceSize(id) > 1 ? "s" : ""}">${pieceSvg(id, color)}</button>`,
    ).join("");
  }
  const live = playing(s);
  for (const btn of tray.querySelectorAll<HTMLButtonElement>(".piece")) {
    const id = btn.dataset.piece as PieceId;
    const have = !!p?.tray.includes(id);
    const fits = app.fits.has(id);
    btn.classList.toggle("used", !have);
    btn.classList.toggle("nofit", have && live && !fits);
    btn.classList.toggle("held", app.held === id);
    btn.disabled = !have || !live;
    btn.title = !have ? "Placed" : live && !fits ? `${pieceDef(id).name}: doesn't fit anywhere right now` : pieceDef(id).name;
  }
  $("tray-count").textContent = seated ? `${p!.tray.length} left · ${squaresLeft(p!.tray)} squares` : "";
}

function renderTools(s: GameState): void {
  const holding = !!app.held && playing(s);
  const check = holding ? ghostCheck() : null;
  for (const id of ["tool-rotate", "tool-flip", "tool-cancel"]) $<HTMLButtonElement>(id).disabled = !holding;
  const placeBtn = $<HTMLButtonElement>("tool-place");
  placeBtn.disabled = !holding || !isMyTurn(s) || !!check?.error || app.placing;
  placeBtn.textContent = app.placing ? "Placing…" : "Place";
  $("tools").classList.toggle("holding", holding);
  board.canvas.classList.toggle("holding", holding);
}

function renderHint(s: GameState): void {
  const p = me(s);
  let text = "";
  if (s.phase === "gameover") text = "Game over. Nobody can move.";
  else if (!p || p.seat < 0) text = "You're watching this game. You'll get a seat when the host starts the next one.";
  else if (p.out === "done") text = "You placed all 21 pieces! Final scores when everyone's done.";
  else if (p.out === "stuck") text = "No moves left for you. Final scores when everyone's done.";
  else if (p.out) text = "You're out of this game. Final scores when everyone's done.";
  else if (app.held) {
    const check = ghostCheck();
    const name = pieceDef(app.held).name;
    if (!app.fits.has(app.held)) text = `The ${name} doesn't fit anywhere right now. Pick another piece.`;
    else if (check?.error) text = check.error;
    else if (!isMyTurn(s)) text = `That fits. Wait for your turn: it's ${shell.player(s.turnPlayerId)?.name ?? "someone"}'s go.`;
    else text = touchUi() ? "That fits! Tap Place to put it down." : "That fits! Click to place it.";
  } else if (isMyTurn(s)) {
    text = isFirstMove(app.pos!, p.seat)
      ? "Your turn: pick a piece. Your first one must cover your starting square (the ring)."
      : "Your turn: pick a piece. The diamonds are your open corners.";
  } else {
    text = `Waiting for ${shell.player(s.turnPlayerId)?.name ?? "the others"}… you can pick a piece and plan meanwhile.`;
  }
  const el = $("hint");
  if (el.textContent !== text) el.textContent = text;
  const check = app.held ? ghostCheck() : null;
  el.classList.toggle("bad", !!app.held && !!check?.error);
  el.classList.toggle("good", !!app.held && !!check && !check.error && isMyTurn(s));
}

const OUT_TAG: Record<string, string> = { stuck: "out of moves", done: "all placed!", away: "away — out", left: "left" };

function renderPlayers(s: GameState): void {
  const rows = seated(s).map((p) => {
    const cls = [s.turnPlayerId === p.id && s.phase === "playing" ? "turn" : "", p.out ? "out" : "", !p.cpu && !p.connected ? "offline" : ""].join(" ");
    const tags = [
      p.id === shell.me ? `<span class="tag tag-you">you</span>` : "",
      p.cpu ? `<span class="tag">CPU · ${p.cpu}</span>` : "",
      p.out ? `<span class="tag tag-out">${OUT_TAG[p.out]}</span>` : "",
      !p.cpu && !p.connected && !p.out ? `<span class="tag">offline</span>` : "",
      s.winners.includes(p.id) ? `<span class="tag tag-host">winner</span>` : "",
    ].join("");
    const minis = PIECE_IDS.map((id) =>
      p.tray.includes(id) ? `<i title="${pieceDef(id).name}">${pieceSvg(id, p.color, [5, 3], 0.2)}</i>` : `<i class="gone"></i>`,
    ).join("");
    return `<li class="${cls}">
      <div class="prow"><span class="chip" style="background:${p.color}"></span><span class="pname">${esc(p.name)}</span>
        <span class="spacer"></span><b class="pscore" title="Score">${p.score}</b></div>
      <div class="pmeta muted">${tags}<span>${p.tray.length} piece${p.tray.length === 1 ? "" : "s"} · ${squaresLeft(p.tray)} squares left</span></div>
      <div class="minis" aria-label="${p.tray.length} pieces left">${minis}</div>
    </li>`;
  });
  const watchers = s.players.filter((p) => p.seat < 0);
  if (watchers.length) rows.push(`<li class="muted watchers">Watching: ${watchers.map((p) => esc(p.name)).join(", ")}</li>`);
  setHtml($("game-players"), rows.join(""));
}

function flashBanner(html: string, ms: number): void {
  app.bannerUntil = performance.now() + ms;
  const el = $("banner");
  el.innerHTML = html;
  el.hidden = false;
}

function renderBanner(): void {
  if (app.bannerUntil) return;
  $("banner").hidden = true;
}

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover" && !app.hideResults;
  $("gameover").hidden = !open;
  if (s.phase !== "gameover") return;
  const ranked = seated(s).sort(rankPlayers);
  const winners = ranked.filter((p) => s.winners.includes(p.id));
  const youWin = s.winners.includes(shell.me);
  $("gameover-title").textContent = youWin ? (winners.length > 1 ? "Shared win!" : "You win!") : "Game over";
  const names = winners.map((p) => `<b style="color:${p.color}">${esc(p.name)}</b>`);
  setHtml(
    $("gameover-winner"),
    winners.length
    ? `${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} share the win` : `${names[0]} wins`} with ${winners[0].score} point${Math.abs(winners[0].score) === 1 ? "" : "s"}.`
      : "",
  );
  let place = 0;
  const rows = ranked
    .map((p, i) => {
      if (i === 0 || p.score !== ranked[i - 1].score) place = i + 1;
      const tie = ranked.filter((o) => o.score === p.score).length > 1;
      const bonus = !p.tray.length ? ` <span class="muted small" title="Placed every piece${p.lastPiece === "1" ? ", monomino last" : ""}">${p.lastPiece === "1" ? "★★" : "★"}</span>` : "";
      return `<tr class="${s.winners.includes(p.id) ? "winner" : ""}">
        <td>${place}${tie ? "=" : ""}</td>
        <td><span class="pcell"><span class="chip" style="background:${p.color}"></span>${esc(p.name)}</span></td>
        <td>${p.score}${bonus}</td><td>${p.tray.length}</td><td>${squaresLeft(p.tray)}</td></tr>`;
    })
    .join("");
  setHtml($("gameover-rows"), rows);
  const back = $<HTMLButtonElement>("gameover-lobby");
  const host = shell.canHost(s);
  back.disabled = !host;
  back.textContent = host ? "Back to lobby" : `Waiting for ${shell.player(s.hostId)?.name ?? "host"}…`;
}

function tickClock(): void {
  const s = shell.state;
  const clock = document.querySelector<HTMLElement>("#hud-turn .clock");
  if (!s || !clock) return;
  const left = s.turnDeadline && s.phase === "playing" ? Math.max(0, s.turnDeadline - shell.serverNow()) : null;
  const text = left === null ? "" : formatClock(left);
  if (clock.textContent !== text) clock.textContent = text;
  clock.classList.toggle("low", left !== null && left < 10000);
}

function formatClock(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
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
  // Keep the whole board on screen beside the tray; on phones it takes the width.
  const byHeight = narrow ? Infinity : window.innerHeight - 150;
  if (board.resize(Math.min(stage.clientWidth, byHeight))) app.dirty = true;
}

// ------------------------------------------------------------------ input

function boardCell(e: PointerEvent | MouseEvent): { x: number; y: number } {
  return board.cellAt(e.clientX, e.clientY);
}

function overBoard(e: PointerEvent): boolean {
  const r = board.canvas.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

/** While dragging a piece with a finger, hold it above the finger so it can be seen. True if it moved. */
function followPointer(e: PointerEvent, touch: boolean): boolean {
  const c = boardCell(e);
  if (touch) c.y -= 1.2 + heldShape().h / 2;
  return centreGhostOn(c.x, c.y);
}

/** Keep getting a pointer's moves after it leaves the element (it may already be gone). */
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

  // The tray: tap or click to pick up (again to put back), or drag a piece onto the board.
  const tray = $("tray");
  tray.addEventListener("pointerdown", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".piece");
    if (!btn || btn.disabled || e.button > 0) return;
    const id = btn.dataset.piece as PieceId;
    const wasHeld = app.held === id;
    if (!wasHeld) {
      app.pointer = null;
      pick(id);
    }
    if (app.held !== id) return;
    capture(btn, e.pointerId);
    app.drag = { kind: "tray", pointerId: e.pointerId, touch: e.pointerType !== "mouse", x0: e.clientX, y0: e.clientY, gx: 0, gy: 0, moved: false, wasHeld };
    e.preventDefault();
  });
  tray.addEventListener("pointermove", (e) => {
    const d = app.drag;
    if (!d || d.kind !== "tray" || d.pointerId !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 8) d.moved = true;
    if (d.moved && overBoard(e) && followPointer(e, d.touch)) renderGhost();
  });
  const endTrayDrag = (e: PointerEvent, cancelled: boolean) => {
    const d = app.drag;
    if (!d || d.kind !== "tray" || d.pointerId !== e.pointerId) return;
    app.drag = null;
    if (cancelled) return;
    if (!d.moved) {
      if (d.wasHeld) {
        drop();
        render();
      }
    } else if (overBoard(e) && !d.touch) {
      // A mouse drag-and-drop places where it lands (if it can).
      app.pointer = boardCell(e);
      const check = ghostCheck();
      if (check && !check.error && isMyTurn()) place();
    }
    (e.target as HTMLElement).blur?.();
  };
  tray.addEventListener("pointerup", (e) => endTrayDrag(e, false));
  tray.addEventListener("pointercancel", (e) => endTrayDrag(e, true));
  tray.addEventListener("click", (e) => {
    // Keyboard activation (pointer clicks are handled above).
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".piece");
    if (!btn || e.detail !== 0) return;
    const id = btn.dataset.piece as PieceId;
    if (app.held === id) drop();
    else pick(id);
    btn.blur();
    render();
  });

  // The board: the mouse carries the ghost and clicks to place; a finger drags the ghost.
  const canvas = board.canvas;
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") {
      app.pointer = boardCell(e);
      if (app.held && !app.drag && centreGhostOn(app.pointer.x, app.pointer.y)) renderGhost();
      return;
    }
    const d = app.drag;
    if (!d || d.kind !== "board" || d.pointerId !== e.pointerId) return;
    const cell = board.cell;
    const dx = (e.clientX - d.x0) / cell;
    const dy = (e.clientY - d.y0) / cell;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 6) d.moved = true;
    if (d.moved && moveGhost(clampGhost(Math.round(d.gx + dx), Math.round(d.gy + dy)))) renderGhost();
  });
  canvas.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") app.pointer = null;
  });
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || !app.held || !app.ghost) return;
    capture(canvas, e.pointerId);
    app.drag = { kind: "board", pointerId: e.pointerId, touch: true, x0: e.clientX, y0: e.clientY, gx: app.ghost.x, gy: app.ghost.y, moved: false, wasHeld: true };
  });
  canvas.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse") {
      if (e.button === 0 && app.held) {
        app.pointer = boardCell(e);
        centreGhostOn(app.pointer.x, app.pointer.y);
        place();
      }
      return;
    }
    const d = app.drag;
    if (!d || d.kind !== "board" || d.pointerId !== e.pointerId) return;
    app.drag = null;
    if (!d.moved) {
      // A tap moves the piece there.
      const c = boardCell(e);
      centreGhostOn(c.x, c.y);
      renderGhost();
    }
  });
  canvas.addEventListener("pointercancel", () => (app.drag = null));
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (app.held) rotate(1);
  });
  let wheel = 0;
  let wheelAt = 0;
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!app.held) return;
      e.preventDefault();
      wheel += e.deltaY;
      const now = performance.now();
      // Trackpads send a stream of small deltas: one turn per notch or per 120 ms.
      if (Math.abs(wheel) >= 40 && now - wheelAt > 120) {
        rotate(wheel > 0 ? 1 : -1);
        wheel = 0;
        wheelAt = now;
      }
    },
    { passive: false },
  );

  // Tool buttons.
  const tool = (id: string, fn: () => void) =>
    $(id).addEventListener("click", (e) => {
      fn();
      (e.currentTarget as HTMLElement).blur();
    });
  tool("tool-rotate", () => rotate(1));
  tool("tool-flip", flip);
  tool("tool-cancel", () => {
    drop();
    render();
  });
  tool("tool-place", place);
  for (const id of ["tool-rotate", "tool-flip", "tool-cancel", "tool-place"]) $(id).addEventListener("mousedown", (e) => e.preventDefault());

  window.addEventListener("keydown", (e) => {
    if (shell.screen !== "game" || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, select, textarea")) return;
    // A focused button handles its own Space/Enter.
    if ((e.key === " " || e.key === "Enter") && target.closest("button")) return;
    const actions: Record<string, () => void> = {
      r: () => rotate(e.shiftKey ? -1 : 1),
      R: () => rotate(e.shiftKey ? -1 : 1),
      f: flip,
      F: flip,
      Escape: () => {
        drop();
        render();
      },
      ArrowLeft: () => nudge(-1, 0),
      ArrowRight: () => nudge(1, 0),
      ArrowUp: () => nudge(0, -1),
      ArrowDown: () => nudge(0, 1),
      Enter: place,
      " ": place,
    };
    const action = actions[e.key];
    if (!action || (!app.held && e.key !== "Escape")) return;
    e.preventDefault();
    action();
  });

  $("gameover-board").addEventListener("click", () => {
    app.hideResults = true;
    render();
  });
  $("hud-turn").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("#show-results")) {
      app.hideResults = false;
      render();
    }
  });
}

wire();
shell.start();
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  Object.assign(window, {
    __cs: {
      app,
      shell,
      /** Dev aid: play a legal move for yourself (the first one a normal CPU would pick is fine). */
      auto() {
        const s = shell.state;
        const p = me(s);
        if (!s || !p || !app.pos || !isMyTurn(s)) return false;
        const best = { m: null as Move | null };
        eachMove(app.pos, p.seat, (m) => {
          if (!best.m || pieceSize(m.piece) > pieceSize(best.m.piece)) best.m = m;
        });
        if (best.m) shell.send({ t: "place", move: best.m });
        return !!best.m;
      },
    },
  });
}
