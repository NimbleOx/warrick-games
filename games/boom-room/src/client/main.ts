import { unlockAudio } from "@warrick/kit/client/audio";
import { $, $$, esc, setHtml, setText, toast } from "@warrick/kit/client/dom";
import { formatClock } from "@warrick/kit/client/format";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { applyDelta, snapTileSolid, type ArenaDelta, type ArenaEvent, type ArenaSnap, type SnapPlayer } from "../shared/arena";
import { FUSE_MS, SHORT_FUSE_MS } from "../shared/constants";
import { OPPOSITE, moveActor, overlaps, type BlockedFn, type Dir } from "../shared/movement";
import {
  SETTING_CHOICES,
  rankPlayers,
  type ClientMsg,
  type GameState,
  type PlayerState,
  type ServerMsg,
} from "../shared/protocol";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { Input } from "./input";
import { CURSE_LABEL, Renderer, type ArenaView, type BombView, type BomberView } from "./render";

// ------------------------------------------------------------------ helpers

const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------------ app state

/** One received frame, kept for interpolating everyone else's movement. */
interface FrameRec {
  time: number;
  players: Map<string, { x: number; y: number; f: Dir }>;
  bombs: Map<number, { x: number; y: number }>;
}

/** Where we think our own bomber is: moved locally every frame, corrected when the server says so. */
interface Local {
  x: number;
  y: number;
  face: Dir;
  fix: number;
}

/** Bombs we've dropped that the server hasn't confirmed yet. */
interface Pending {
  c: number;
  at: number;
  explodeAt: number;
}

/** Draw other bombers this far in the past, so there are frames on both sides to blend between. */
const INTERP_MS = 90;
const SEND_MS = 33;

const app = {
  snap: null as ArenaSnap | null,
  /** The arena that came with the welcome, drawn once its state is in. */
  welcomeFrame: null as ArenaSnap | null,
  frames: [] as FrameRec[],
  /** Arena time ≈ performance.now() + clock. */
  clock: NaN,
  local: null as Local | null,
  pending: [] as Pending[],
  sent: { x: NaN, y: NaN, d: 0 as Dir, at: 0 },
  drawn: new Map<string, BomberView>(),
  banner: { html: "", cls: "", until: 0 },
  countShown: -1,
  lastFrame: 0,
  winKey: "",
  /** Asked for the whole arena after a delta that didn't fit, and waiting for it. */
  syncing: false,
};

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "boom-room",
  title: "Boom Room",
  prefix: "br",
  logo: "BOOM<br />ROOM",
  tagline: "Real-time bomb battles for friends.<br />No accounts — just share a code.",
  placeholder: "Bomber",
  footer: "A love letter to <em>Bomberman</em> (1983).",
  playersLabel: "Bombers",
  settings: {
    wins: { label: "First to", fmt: (v: number) => `${v} win${v > 1 ? "s" : ""}` },
    hurrySeconds: {
      label: "Hurry up",
      fmt: (v: number) => (v ? `After ${formatClock(v * 1000)}` : "Never"),
    },
    crates: { label: "Crates", fmt: (v: string) => ({ sparse: "Sparse", normal: "Normal", packed: "Packed" })[v] ?? v },
    items: { label: "Power-ups", fmt: (v: string) => ({ few: "Few", normal: "Normal", lots: "Lots" })[v] ?? v },
    skulls: { label: "Skulls", fmt: (v: boolean) => (v ? "On — curses spread" : "Off") },
  },
  choices: SETTING_CHOICES,
  onWelcome: (msg) => {
    clearArena();
    if (msg.t === "welcome") app.welcomeFrame = msg.frame;
  },
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s): string | null =>
    s.phase !== "lobby" && s.phase !== "gameover" ? "Leave this game? You'll sit out the rest of it." : null,
  isLive: (s) => s.phase === "playing",
});
const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));
const input = new Input(() => shell.screen === "game", dropBomb);

const me = (s = shell.state): PlayerState | undefined => s?.players.find((p) => p.id === shell.me);
const playerById = (id: string | null | undefined) => shell.player(id);
const mySnap = (f = app.snap): SnapPlayer | undefined => f?.players.find((p) => p.id === shell.me);
const canHost = (s = shell.state) => shell.canHost(s);

function arenaNow(): number {
  const f = app.snap;
  if (!f) return 0;
  // Don't run on ahead if frames stop coming.
  return Math.min(performance.now() + app.clock, f.time + 300);
}

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  input.clear();
  if (screen === "game") layoutStage();
  if (screen === "home") attract.resize();
}

/** Left the game, or lost it for good. */
function onReset(): void {
  clearArena();
  $("gameover").hidden = true;
}

function clearArena(): void {
  app.snap = null;
  app.syncing = false;
  app.frames = [];
  app.local = null;
  app.pending = [];
  app.drawn.clear();
}

// ------------------------------------------------------------------ messages

function onMessage(msg: ServerMsg): void {
  if (msg.t === "frame") {
    app.syncing = false;
    onFrame(msg.f);
  } else if (msg.t === "delta") {
    onDelta(msg.f);
  }
}

function onDelta(d: ArenaDelta): void {
  const prev = app.snap;
  if (!prev || d.time < prev.time) {
    // Nothing to lay it over: ask for the whole arena, and skip deltas until it comes.
    if (!app.syncing) app.syncing = shell.send({ t: "sync" });
    return;
  }
  if (!app.syncing) onFrame(applyDelta(prev, d));
}

function onState(s: GameState, prev: GameState | null): void {
  if (s.phase === "lobby") clearArena();
  if (s.phase === "roundover" && prev?.phase === "playing") {
    if (s.roundWinnerId === shell.me) sfx.win();
  }
  if (s.phase !== "lobby") renderGame(s);
  const f = app.welcomeFrame;
  app.welcomeFrame = null;
  if (f) onFrame(f);
}

function onFrame(f: ArenaSnap): void {
  const now = performance.now();
  const prev = app.snap;
  const newRound = !prev || f.time < prev.time || f.cols !== prev.cols || f.rows !== prev.rows;
  if (newRound) {
    app.frames = [];
    app.local = null;
    app.pending = [];
    app.countShown = -1;
    app.clock = NaN;
    renderer.reset();
    // Ticks can come as deltas from here on. Said for every new arena: the room forgets when it sleeps.
    shell.send({ t: "deltas" });
  }
  const sample = f.time - now;
  if (!Number.isFinite(app.clock) || Math.abs(sample - app.clock) > 400) app.clock = sample;
  // Lean towards the frames that arrived quickest; late ones are just network jitter.
  else app.clock += (sample - app.clock) * (sample > app.clock ? 0.3 : 0.03);

  app.frames.push({
    time: f.time,
    players: new Map(f.players.map((p) => [p.id, { x: p.x, y: p.y, f: p.f }])),
    bombs: new Map(f.bombs.map((b) => [b.id, { x: b.x, y: b.y }])),
  });
  if (app.frames.length > 40) app.frames.shift();
  app.snap = f;
  if (newRound && shell.screen === "game") layoutStage();

  const mine = mySnap(f);
  if (mine) {
    // The server overrode us (or this is the first we've heard): jump to where it says.
    if (!app.local || app.local.fix !== mine.fix) app.local = { x: mine.x, y: mine.y, face: mine.f, fix: mine.fix };
  } else {
    app.local = null;
  }
  app.pending = app.pending.filter(
    (pb) => now - pb.at < 700 && !f.bombs.some((b) => b.o === shell.me && Math.round(b.y) * f.cols + Math.round(b.x) === pb.c),
  );

  for (const ev of f.ev) onArenaEvent(ev, f, now);
  renderHudStats();
  renderPlayers();
  renderParticipation();
}

let dropSound = 0;

function onArenaEvent(ev: ArenaEvent, f: ArenaSnap, now: number): void {
  switch (ev.e) {
    case "boom":
      sfx.boom(ev.n);
      break;
    case "pick":
      if (ev.id === shell.me) ev.k === "skull" ? sfx.curse() : sfx.pickup();
      break;
    case "pass":
      if (ev.id === shell.me) {
        sfx.curse();
        toast(`You caught ${CURSE_LABEL[ev.k]}!`, "info");
      }
      break;
    case "kick":
      sfx.kick();
      break;
    case "die":
      sfx.die();
      if (ev.id === shell.me) flashBanner(`<span class="big">You're out!</span>Watch the rest of the round.`, 2200);
      break;
    case "hurry":
      sfx.hurry();
      flashBanner(`<span class="big">HURRY UP!</span>The walls are closing in.`, 2400, "hurry");
      break;
    case "drop":
      if (++dropSound % 3 === 0) sfx.drop();
      break;
    case "go":
      sfx.go();
      break;
  }
  renderer.onEvent(ev, f, now, (id) => {
    const d = app.drawn.get(id);
    return d ? { x: d.x, y: d.y, face: d.face, color: d.color } : null;
  });
}

// ------------------------------------------------------------------ moving & bombing

function bombCells(f: ArenaSnap): Set<number> {
  const cells = new Set(f.bombs.map((b) => Math.round(b.y) * f.cols + Math.round(b.x)));
  for (const pb of app.pending) cells.add(pb.c);
  return cells;
}

function blockedFor(f: ArenaSnap, from: { x: number; y: number }): BlockedFn {
  const bombs = bombCells(f);
  return (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= f.cols || cy >= f.rows) return true;
    const c = cy * f.cols + cx;
    if (snapTileSolid(f.grid[c])) return true;
    return bombs.has(c) && !overlaps(from.x, from.y, cx, cy);
  };
}

/** Move our own bomber right away (no waiting for the server), and tell the server where we went. */
function predict(dt: number, now: number): void {
  const s = shell.state;
  const f = app.snap;
  const loc = app.local;
  const mine = mySnap(f);
  if (!s || !f || !loc || !mine?.alive || s.phase !== "playing" || arenaNow() < f.goAt) return;
  let dir = input.dir();
  if (mine.c === "reverse") dir = OPPOSITE[dir];
  if (dir) {
    moveActor(loc, dir, (mine.s * dt) / 1000, blockedFor(f, { x: loc.x, y: loc.y }));
    loc.face = dir;
  }
  const moved = loc.x !== app.sent.x || loc.y !== app.sent.y;
  const turned = dir !== app.sent.d;
  if ((moved && now - app.sent.at >= SEND_MS) || turned) {
    if (shell.send({ t: "move", x: round3(loc.x), y: round3(loc.y), d: dir })) {
      app.sent = { x: loc.x, y: loc.y, d: dir, at: now };
    }
  }
}

function dropBomb(): void {
  unlockAudio();
  const s = shell.state;
  const f = app.snap;
  const loc = app.local;
  const mine = mySnap(f);
  if (!s || !f || !loc || !mine?.alive || s.phase !== "playing") return;
  if (arenaNow() < f.goAt || mine.c === "nobomb") return;
  const c = Math.round(loc.y) * f.cols + Math.round(loc.x);
  const mineOut = f.bombs.filter((b) => b.o === shell.me).length + app.pending.length;
  if (mineOut >= mine.b || bombCells(f).has(c) || snapTileSolid(f.grid[c])) return;
  const fuse = mine.c === "shortfuse" ? SHORT_FUSE_MS : FUSE_MS;
  app.pending.push({ c, at: performance.now(), explodeAt: arenaNow() + fuse });
  if (shell.send({ t: "bomb", x: round3(loc.x), y: round3(loc.y), d: app.sent.d })) {
    app.sent.x = loc.x;
    app.sent.y = loc.y;
  }
  sfx.place();
}

// ------------------------------------------------------------------ frame loop

let lastNow = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(50, lastNow ? now - lastNow : 16);
  lastNow = now;
  input.pollGamepad();
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game") return;
  if (app.snap && shell.state && shell.state.phase !== "lobby") {
    predict(dt, now);
    renderer.draw(buildView(), now);
  }
  tickClocks(now);
}

function buildView(): ArenaView {
  const f = app.snap!;
  const s = shell.state!;
  const t = arenaNow();
  const rt = t - INTERP_MS;
  const fr = app.frames;
  let a = fr[fr.length - 1];
  let b = a;
  for (let i = fr.length - 1; i > 0; i--) {
    if (fr[i - 1].time <= rt) {
      a = fr[i - 1];
      b = fr[i];
      break;
    }
    a = b = fr[i - 1];
  }
  const k = b.time > a.time ? Math.min(1, Math.max(0, (rt - a.time) / (b.time - a.time))) : 1;
  const lerp = <T extends { x: number; y: number }>(pa: T | undefined, pb: T | undefined, x: number, y: number) => {
    if (!pa || !pb || Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y) > 2) return { x, y };
    return { x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k };
  };

  const bombers: BomberView[] = f.players.map((p) => {
    const pl = playerById(p.id);
    let pos = { x: p.x, y: p.y };
    let face = p.f;
    if (p.id === shell.me && app.local) {
      pos = app.local;
      face = app.local.face;
    } else {
      pos = lerp(a.players.get(p.id), b.players.get(p.id), p.x, p.y);
      face = b.players.get(p.id)?.f ?? p.f;
    }
    return {
      id: p.id,
      x: pos.x,
      y: pos.y,
      face,
      alive: p.alive,
      color: pl?.color ?? "#cccccc",
      name: pl?.name ?? "",
      you: p.id === shell.me,
      curse: p.c,
    };
  });
  app.drawn = new Map(bombers.map((bv) => [bv.id, bv]));

  const bombs: BombView[] = f.bombs.map((bm) => {
    const pos = bm.s ? lerp(a.bombs.get(bm.id), b.bombs.get(bm.id), bm.x, bm.y) : bm;
    return { id: bm.id, x: pos.x, y: pos.y, at: bm.at, owner: bm.o };
  });
  for (const pb of app.pending) {
    bombs.push({ id: `pending${pb.c}`, x: pb.c % f.cols, y: Math.floor(pb.c / f.cols), at: pb.explodeAt, owner: shell.me });
  }
  return {
    snap: f,
    time: Math.max(t, f.time),
    bombers,
    bombs,
    labels: true,
    cheer: s.phase === "roundover" ? s.roundWinnerId : null,
    colorOf: (id) => playerById(id)?.color ?? "#ffffff",
  };
}

function tickClocks(now: number): void {
  const s = shell.state;
  if (!s || s.phase === "lobby") return;
  const f = app.snap;
  const t = arenaNow();
  const clock = document.querySelector<HTMLElement>("#hud-status .clock");
  if (clock && f) {
    let text = "";
    let hurry = false;
    if (s.phase === "playing" && f.hurryAt !== null) {
      const left = f.hurryAt - Math.max(t, f.goAt);
      hurry = left <= 0;
      text = hurry ? "HURRY!" : formatClock(left);
    }
    setText(clock, text);
    clock.classList.toggle("hurry", hurry);
  }
  if (s.phase === "roundover" && s.phaseDeadline) {
    const secs = String(Math.max(0, Math.ceil((s.phaseDeadline - shell.serverNow()) / 1000)));
    for (const el of $$("[data-countdown]")) setText(el, secs);
  }
  // Countdown beeps.
  if (f && s.phase === "playing" && t < f.goAt) {
    const n = Math.ceil((f.goAt - t) / 1000);
    if (n !== app.countShown && n <= 3) {
      app.countShown = n;
      sfx.count();
    }
  }
  renderBanner(now);
}

// ------------------------------------------------------------------ game

function renderGame(s: GameState): void {
  renderHudStatus(s);
  renderHudStats();
  renderPlayers();
  renderGameOver(s);
  renderParticipation();
}

function renderHudStatus(s: GameState): void {
  let who = "";
  if (s.phase === "playing") {
    const mine = me(s);
    const label = !mine || mine.spectator ? "Watching" : !mine.inRound ? "Sitting this round out" : `Round ${s.round}`;
    who = `<span class="who">${label}</span>`;
  } else if (s.phase === "roundover") {
    const w = playerById(s.roundWinnerId);
    who = w
      ? `<span class="who"><span class="chip" style="background:${w.color}"></span>${esc(w.name)} wins!</span>`
      : `<span class="who">Draw</span>`;
  } else if (s.phase === "gameover") {
    who = `<span class="who">Game over</span>`;
  }
  setHtml($("hud-status"), `${who}<span class="clock"></span>`);
  setText($("hud-round"), s.round ? `${s.round}` : "—");
  setText($("game-target"), `first to ${s.settings.wins}`);
}

function renderHudStats(): void {
  const p = mySnap();
  const alive = !!p?.alive;
  setText($("hud-bombs"), alive ? String(p.b) : "—");
  setText($("hud-fire"), alive ? String(p.r) : "—");
  const speed = $("hud-speed");
  const kick = $("hud-kick");
  if (alive && p.c) {
    setText(speed, `${CURSE_LABEL[p.c]} ${Math.ceil(p.cl / 1000)}s`);
    speed.className = "curse";
    speed.title = "Cursed! Bump into someone to pass it on.";
  } else {
    setText(speed, alive ? String(p.sl + 1) : "—");
    speed.className = "";
    speed.title = "";
  }
  setText(kick, alive ? (p.k ? "Yes" : "No") : "—");
  kick.className = alive && p.k ? "on" : "";
}

function stars(n: number, of: number): string {
  const full = Math.min(n, of);
  return `${"★".repeat(full)}<span class="empty">${"★".repeat(Math.max(0, of - full))}</span>`;
}

function renderPlayers(): void {
  const s = shell.state;
  if (!s || s.phase === "lobby") return;
  const f = app.snap;
  const rows = s.players
    .filter((p) => !p.spectator)
    .map((p) => {
      const sp = f?.players.find((q) => q.id === p.id);
      const inRound = !!sp && p.inRound;
      const dead = inRound && !sp!.alive;
      const cls = [
        dead ? "dead" : "",
        !inRound && s.phase === "playing" ? "out" : "",
        !p.cpu && !p.connected ? "offline" : "",
        s.phase === "roundover" && s.roundWinnerId === p.id ? "winner" : "",
      ].join(" ");
      const tag = p.id === shell.me ? ` <span class="tag tag-you">you</span>` : p.cpu ? ` <span class="tag">CPU</span>` : "";
      let status = "";
      if (s.phase === "playing" || s.phase === "roundover") {
        if (!inRound) status = "sitting out";
        else if (dead) status = "K.O.";
        else
          status = `💣${sp!.b} 🔥${sp!.r} 👟${sp!.sl + 1}${sp!.k ? " · kick" : ""}${sp!.c ? ` · <span class="bad">☠ ${CURSE_LABEL[sp!.c]}</span>` : ""}`;
      }
      return `<li class="${cls}">
        <span class="chip" style="background:${p.color}"></span>
        <span class="pname">${esc(p.name)}${tag}</span>
        <span class="stars" title="${p.wins} round win${p.wins === 1 ? "" : "s"}">${stars(p.wins, s.settings.wins)}</span>
        ${status ? `<div class="status">${status}</div>` : ""}
      </li>`;
    });
  const spectators = s.players.filter((p) => p.spectator);
  if (spectators.length) {
    rows.push(`<li class="muted" style="display:block">Watching: ${spectators.map((p) => esc(p.name)).join(", ")}</li>`);
  }
  setHtml($("game-players"), rows.join(""));
}

function renderParticipation(): void {
  const s = shell.state;
  if (!s) return;
  const p = me(s);
  const sp = mySnap();
  const playing = s.phase === "playing" && !!p && !p.spectator && p.inRound && !!sp?.alive;
  if ($("touchpad").hidden !== !playing) {
    $("touchpad").hidden = !playing;
    if (shell.screen === "game") layoutStage();
  }
  const waiting = $("waiting");
  let text = "";
  if (s.phase === "playing") {
    if (!p || p.spectator) text = "You're watching this game. You'll get a bomber when the host starts the next one.";
    else if (!p.inRound) text = "You'll join in from the next round.";
    else if (sp && !sp.alive) text = "You're out this round. Hang tight for the next one.";
  }
  waiting.hidden = !text;
  setText(waiting, text);
}

function flashBanner(html: string, ms: number, cls = ""): void {
  app.banner = { html, cls, until: performance.now() + ms };
}

function renderBanner(now: number): void {
  const s = shell.state;
  const f = app.snap;
  const el = $("banner");
  if (!s) return;
  let html = "";
  let cls = "";
  const t = arenaNow();
  if (s.phase === "roundover") {
    const winner = playerById(s.roundWinnerId);
    const head = winner
      ? `<span class="big" style="color:${winner.color}">${esc(winner.name)} wins round ${s.round}</span>`
      : `<span class="big">Round ${s.round} is a draw</span>`;
    const board = s.players
      .filter((p) => !p.spectator)
      .sort((a, b) => b.wins - a.wins)
      .map(
        (p) =>
          `<div><span class="chip" style="background:${p.color}"></span>${esc(p.name)}<span class="stars">${stars(p.wins, s.settings.wins)}</span></div>`,
      )
      .join("");
    const champion = s.players.some((p) => p.wins >= s.settings.wins);
    html = `${head}<div class="trophies">${board}</div>${champion ? "Final results" : "Next round"} in <span data-countdown></span>s`;
  } else if (s.phase === "playing" && f && t < f.goAt) {
    html = `<span class="count">${Math.ceil((f.goAt - t) / 1000)}</span>`;
    cls = "bare";
  } else if (s.phase === "playing" && f && t < f.goAt + 700) {
    html = `<span class="count">GO!</span>`;
    cls = "bare";
  } else if (app.banner.until > now) {
    html = app.banner.html;
    cls = `flash ${app.banner.cls}`;
  }
  if (!html) {
    el.hidden = true;
    el.dataset.html = "";
    return;
  }
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
    // Fill the countdown straight away rather than on the next tick.
    if (s.phaseDeadline) {
      for (const c of el.querySelectorAll<HTMLElement>("[data-countdown]")) {
        c.textContent = String(Math.max(0, Math.ceil((s.phaseDeadline - shell.serverNow()) / 1000)));
      }
    }
  }
  el.className = `banner ${cls}`;
  el.hidden = false;
}

// ------------------------------------------------------------------ game over

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover";
  $("gameover").hidden = !open;
  if (!open) return;
  const ranked = s.players.filter((p) => !p.spectator).sort(rankPlayers);
  const best = ranked[0];
  $("gameover-winner").innerHTML = best ? `<b style="color:${best.color}">${esc(best.name)}</b> rules the room.` : "";
  $("gameover-rows").innerHTML = ranked
    .map(
      (p, i) => `<tr>
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${p.color}"></span>${esc(p.name)}</span></td>
        <td>${p.wins}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.items}</td></tr>`,
    )
    .join("");
  const back = $<HTMLButtonElement>("gameover-lobby");
  const host = canHost(s);
  back.disabled = !host;
  back.textContent = host ? "Back to lobby" : `Waiting for ${playerById(s.hostId)?.name ?? "host"}…`;
}

// ------------------------------------------------------------------ layout

function layoutStage(): void {
  const col = document.querySelector<HTMLElement>(".stage-col")!;
  const touch = window.matchMedia("(pointer: coarse)").matches && !$("touchpad").hidden;
  // Keep everything on screen: cap the arena's width by the height that's left.
  const reserved = (window.innerWidth <= 760 ? 175 : 200) + (touch ? 175 : 0);
  const aspect = app.snap ? app.snap.cols / app.snap.rows : renderer.aspect;
  const maxByHeight = (window.innerHeight - reserved) * aspect;
  col.style.maxWidth = `${Math.max(300, Math.round(maxByHeight))}px`;
  col.style.margin = "0 auto";
  col.style.width = "100%";
  const f = app.snap;
  renderer.resize($("stage").clientWidth || col.clientWidth, f?.cols, f?.rows);
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  window.addEventListener("resize", () => (shell.screen === "home" ? attract.resize() : layoutStage()));
  new ResizeObserver(() => shell.screen === "game" && renderer.resize($("stage").clientWidth)).observe($("stage"));
  input.attachDpad($("dpad"));
  input.attachBombButton($("bomb-btn"));
}

wire();
shell.start();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __br: { app, shell, renderer } });
