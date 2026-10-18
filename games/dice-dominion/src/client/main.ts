import { unlockAudio } from "@warrick/kit/client/audio";
import { $, $$, esc, toast } from "@warrick/kit/client/dom";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { dropMs } from "../shared/constants";
import type { HexMap } from "../shared/map";
import { winChance } from "../shared/odds";
import {
  SETTING_CHOICES,
  standings,
  type AttackEvent,
  type ClientMsg,
  type DropEvent,
  type GameState,
  type PlayerState,
  type ServerMsg,
  type WelcomeExtra,
} from "../shared/protocol";
import { largestGroup, legalAttacks, sum, targetsOf, territoryCount } from "../shared/rules";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { MapView, type Board, type Overlay } from "./render";

// ------------------------------------------------------------------ app state

interface Roll {
  ev: AttackEvent;
  /** The defender's seat, from before the attack. */
  defSeat: number;
}

type Anim =
  | { kind: "attack"; roll: Roll; start: number; dur: number; revealed: boolean; faces: number }
  | { kind: "drop"; ev: DropEvent; start: number; dur: number; shown: number };

const app = {
  map: null as HexMap | null,
  /** The board as drawn: the last state's, or partway through an animation. */
  board: { owner: [], dice: [] } as Board,
  /** Attacks, dice drops and states waiting for the animation in front of them. */
  queue: [] as ServerMsg[],
  anim: null as Anim | null,
  lastRoll: null as Roll | null,
  selected: -1,
  hover: -1,
  flash: new Map<number, number>(),
  /** An attack is on its way to the server. */
  pending: false,
  turnKey: "",
  warning: { text: "", until: 0 },
  bannerUntil: 0,
  syncAskedAt: 0,
  dirty: true,
};

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "dice-dominion",
  title: "Dice Dominion",
  prefix: "dd",
  logo: "DICE<br />DOMINION",
  tagline: "Roll for territory with friends.<br />No accounts — just share a code.",
  placeholder: "Warlord",
  footer: "After <em>Dice Wars</em> and <em>KDice</em>.",
  rules: [
    "Attack a neighbour by rolling your whole stack against theirs. Higher total wins; ties go to the defender.",
    "End your turn to get a die for each territory in your largest connected group.",
    "Take the whole map to win.",
  ],
  settings: {
    size: { label: "Map size", fmt: (v: number) => `${v} territories each` },
    turnSeconds: { label: "Turn timer", fmt: (v: number) => (v ? `${v} seconds` : "No limit") },
    fastCpus: { label: "CPU speed", fmt: (v: boolean) => (v ? "Fast" : "Easy to follow") },
  },
  choices: SETTING_CHOICES,
  intercept,
  onWelcome: (msg) => {
    app.queue = [];
    app.anim = null;
    app.pending = false;
    app.selected = -1;
    const map = (msg as Partial<WelcomeExtra>).map;
    if (map) setMap(map);
  },
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s): string | null =>
    s.phase === "playing" && (mine(s)?.seat ?? -1) >= 0 && mine(s)?.outRound === null
      ? "Leave this game? Your territories stay on the map, and the host can hand them to a CPU."
      : null,
});
const view = new MapView($<HTMLCanvasElement>("map"));
const attract = new Attract($<HTMLCanvasElement>("attract"));

const mine = (s = shell.state): PlayerState | undefined => s?.players.find((p) => p.id === shell.me);
const seatPlayer = (s: GameState, seat: number) => s.players.find((p) => p.id === s.order[seat]);
const mySeat = (s = shell.state) => mine(s)?.seat ?? -1;
const isMyTurn = (s = shell.state): boolean =>
  !!s &&
  s.phase === "playing" &&
  !s.winnerId &&
  s.timer?.kind !== "drop" &&
  s.order[s.turn] === shell.me &&
  !mine(s)?.cpu &&
  mine(s)?.outRound === null;
const seatColors = (s: GameState) => s.order.map((id) => shell.player(id)?.color ?? "#888888");

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "game") {
    layoutStage();
    // The log filled up while this screen was hidden: start at the latest entry.
    for (const ol of $$("[data-log]")) ol.scrollTop = ol.scrollHeight;
  }
  if (screen === "home") attract.resize();
}

/** Left the game, or lost it for good. */
function onReset(): void {
  app.queue = [];
  app.anim = null;
  app.lastRoll = null;
  app.selected = -1;
  app.map = null;
  $("gameover").hidden = true;
}

// ------------------------------------------------------------------ messages

/** Attacks and dice drops animate; anything after them waits its turn. */
function intercept(msg: ServerMsg): boolean {
  if (msg.t !== "state" && msg.t !== "attack" && msg.t !== "drop" && msg.t !== "map") return false;
  app.queue.push(msg);
  pump();
  return true;
}

function pump(): void {
  while (!app.anim && app.queue.length) {
    const msg = app.queue.shift()!;
    if (msg.t === "state") shell.applyState(msg.state);
    else if (msg.t === "attack") startAttack(msg.attack);
    else if (msg.t === "drop") startDrop(msg.drop);
    else if (msg.t === "map") {
      setMap(msg.map);
      // The answer to "sync": show the state that was waiting for it.
      if (shell.state?.mapId === msg.map.id) shell.applyState(shell.state);
    }
  }
}

function setMap(map: HexMap): void {
  if (map.id === app.map?.id) return;
  app.map = map;
  view.setMap(map);
  app.lastRoll = null;
  app.flash.clear();
  layoutStage();
}

/** Behind (a hidden tab, a slow phone): hurry the animations along. */
function backlog(): number {
  return app.queue.filter((m) => m.t !== "state").length;
}

function onMessage(msg: ServerMsg): void {
  if (msg.t === "error") {
    app.pending = false;
    app.dirty = true;
  }
}

function onState(s: GameState, prev: GameState | null): void {
  if (s.phase === "lobby") {
    app.selected = -1;
    return;
  }
  if (!app.map || app.map.id !== s.mapId) {
    // A game whose map we don't have (we missed the one that started it): ask for it.
    if (performance.now() - app.syncAskedAt > 3000) {
      app.syncAskedAt = performance.now();
      shell.send({ t: "sync" });
    }
    return;
  }
  app.board = { owner: s.owner.slice(), dice: s.dice.slice() };
  if (app.selected >= 0 && (!isMyTurn(s) || !targetsOf(app.map.adj, s.owner, s.dice, app.selected).length || s.owner[app.selected] !== mySeat(s))) {
    app.selected = -1;
  }

  const key = `${s.mapId}:${s.turnNo}`;
  if (isMyTurn(s) && key !== app.turnKey) {
    app.turnKey = key;
    app.pending = false;
    sfx.turn();
    flashBanner(`<span class="big">YOUR TURN</span>`, 1200);
  }
  const me = mine(s);
  const was = prev?.players.find((p) => p.id === shell.me);
  if (me && was && was.outRound === null && me.outRound !== null && s.phase === "playing") {
    sfx.knockout();
    flashBanner(`<span class="big">YOU'RE OUT</span>You can keep watching.`, 2500);
  }
  if (s.winnerId && !prev?.winnerId) sfx.victory();
  document.title = isMyTurn(s) ? "▶ Your turn — Dice Dominion" : `Dice Dominion · ${s.code}`;
  renderGame(s);
}

// ------------------------------------------------------------------ animations

function startAttack(ev: AttackEvent): void {
  const s = shell.state;
  if (!s || !app.map) return;
  const roll: Roll = { ev, defSeat: app.board.owner[ev.to] };
  app.lastRoll = roll;
  if (ev.seat === mySeat(s)) {
    app.pending = false;
    app.selected = -1;
  }
  const cpu = !!seatPlayer(s, ev.seat)?.cpu;
  const dur = document.hidden || backlog() > 4 ? 0 : backlog() ? 240 : cpu && s.settings.fastCpus ? 300 : 650;
  if (!dur) {
    if (ev.won) app.flash.set(ev.to, performance.now());
    renderRollbar();
    return;
  }
  app.anim = { kind: "attack", roll, start: performance.now(), dur, revealed: false, faces: 0 };
  sfx.roll();
  renderRollbar();
  renderHint();
}

function startDrop(ev: DropEvent): void {
  const s = shell.state;
  if (!s) return;
  const total = dropMs(ev.placed.length, s.settings.fastCpus);
  // Land them a little faster than the server waits, so the next turn's state isn't held up.
  const dur = document.hidden || backlog() > 2 || !ev.placed.length ? 0 : backlog() ? 200 : Math.max(150, total - 250);
  if (!dur) return;
  app.anim = { kind: "drop", ev, start: performance.now(), dur, shown: 0 };
}

/** Move the current animation along; finish it when its time is up (or right away). */
function stepAnim(now: number, finish = false): void {
  const a = app.anim;
  if (!a) return;
  const t = finish ? 1 : (now - a.start) / a.dur;
  if (a.kind === "attack") {
    if (!a.revealed && t >= 0.55) {
      a.revealed = true;
      if (a.roll.ev.won) app.flash.set(a.roll.ev.to, now);
      if (!finish) (a.roll.ev.won ? sfx.win : sfx.lose)();
      renderRollbar();
    } else if (!a.revealed && Math.floor(now / 70) !== a.faces) {
      a.faces = Math.floor(now / 70);
      renderRollbar();
    }
  } else {
    const placed = a.ev.placed;
    const due = Math.min(placed.length, Math.ceil((placed.length * t) / 0.85));
    for (; a.shown < due; a.shown++) {
      const terr = placed[a.shown];
      app.board.dice[terr]++;
      app.flash.set(terr, now);
      if (!finish && a.shown % 2 === 0) sfx.drop();
    }
  }
  app.dirty = true;
  if (t >= 1) {
    app.anim = null;
    pump();
  }
}

/** Skip whatever is animating, and everything queued behind it. */
function skipAnims(): void {
  for (let guard = 0; app.anim && guard < 500; guard++) stepAnim(performance.now(), true);
}

// ------------------------------------------------------------------ frame loop

let lastFrame = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  lastFrame = performance.now();
  render(now);
}

// Animation frames can stop while the page still counts as visible (an occluded window, say).
// Keep the animations, and so the queue of states behind them, moving anyway.
setInterval(() => {
  if (performance.now() - lastFrame > 250 && shell.screen === "game") render(performance.now());
}, 120);

function render(now: number): void {
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game") return;
  stepAnim(now);
  const s = shell.state;
  let flashing = false;
  for (const [t, at] of app.flash) {
    if (now - at < 400) flashing = true;
    else {
      app.flash.delete(t);
      app.dirty = true; // one more frame without it
    }
  }
  if (s && app.map && (app.dirty || app.anim || flashing || app.selected >= 0)) {
    app.dirty = false;
    view.draw(app.board, overlay(s), now);
  }
  tickClock(s);
  if (app.bannerUntil && performance.now() > app.bannerUntil) {
    app.bannerUntil = 0;
    if (s) renderBanner(s);
  }
  if (app.warning.until && performance.now() > app.warning.until) {
    app.warning.until = 0;
    renderHint();
  }
}

function overlay(s: GameState): Overlay {
  const targets = new Map<number, number>();
  if (app.selected >= 0 && app.map) {
    for (const t of targetsOf(app.map.adj, app.board.owner, app.board.dice, app.selected)) {
      targets.set(t, winChance(app.board.dice[app.selected], app.board.dice[t]));
    }
  }
  const a = app.anim?.kind === "attack" ? app.anim : null;
  return {
    colors: seatColors(s),
    selected: app.selected,
    targets,
    hover: app.hover,
    attack: a ? { from: a.roll.ev.from, to: a.roll.ev.to, won: a.revealed ? a.roll.ev.won : null } : null,
    flash: app.flash,
    active: s.phase === "playing" && !s.winnerId ? s.turn : -1,
  };
}

function tickClock(s: GameState | null): void {
  const clock = document.querySelector<HTMLElement>("#hud-turn .clock");
  if (!clock || !s) return;
  const left = s.phase === "playing" && s.turnDeadline && !s.winnerId ? Math.max(0, s.turnDeadline - shell.serverNow()) : null;
  const text = left === null ? "" : formatClock(left);
  if (clock.textContent !== text) clock.textContent = text;
  clock.classList.toggle("low", left !== null && left < 10000);
}

function formatClock(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ rendering

function renderGame(s: GameState): void {
  renderHud(s);
  renderPlayers(s);
  renderHint();
  renderRollbar();
  renderBanner(s);
  renderGameOver(s);
  app.dirty = true;
}

function renderHud(s: GameState): void {
  const turn = seatPlayer(s, s.turn);
  let who = "";
  if (s.phase === "playing" && s.winnerId) {
    const w = shell.player(s.winnerId);
    who = `<span class="chip" style="background:${w?.color}"></span><span class="who">${esc(w?.name ?? "?")} wins!</span>`;
  } else if (s.phase === "playing" && turn) {
    const label =
      turn.id === shell.me && !turn.cpu
        ? "Your turn"
        : `${esc(turn.name)}'s turn${turn.cpu ? "" : turn.connected ? "" : " (away)"}`;
    who = `<span class="chip" style="background:${turn.color}"></span><span class="who">${label}</span>`;
  } else if (s.phase === "gameover") who = `<span class="who">Game over</span>`;
  const html = `${who}<span class="round">Round ${s.round}</span><span class="clock"></span>`;
  const el = $("hud-turn");
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }

  const btn = $<HTMLButtonElement>("end-turn");
  const me = mine(s);
  const playing = s.phase === "playing" && !!me && me.seat >= 0 && me.outRound === null;
  btn.hidden = !playing;
  btn.disabled = !isMyTurn(s);
  if (playing && app.map) {
    const gain = largestGroup(app.map.adj, s.owner, me.seat);
    btn.innerHTML = `End turn <span class="gain">+${gain + me.reserve}</span>`;
    btn.title = `End your turn: ${gain} new dice for your largest group${me.reserve ? `, plus ${me.reserve} saved` : ""} (Enter)`;
    btn.classList.toggle("nudge", isMyTurn(s) && !legalAttacks(app.map.adj, s.owner, s.dice, me.seat).length);
  }

  const fast = $<HTMLButtonElement>("fast");
  const anyCpu = s.players.some((p) => p.cpu && p.seat >= 0);
  fast.hidden = !shell.canHost(s) || !anyCpu || s.phase !== "playing";
  fast.setAttribute("aria-pressed", String(s.settings.fastCpus));
  fast.title = s.settings.fastCpus ? "Fast CPUs are on: click to slow them down" : "Fast CPUs: let them attack without pausing";
}

function renderPlayers(s: GameState): void {
  if (!app.map) return;
  const host = shell.canHost(s);
  const rows = s.order.map((id, seat) => {
    const p = shell.player(id);
    if (!p) return "";
    const land = territoryCount(s.owner, seat);
    const out = p.outRound !== null;
    const cls = [
      s.phase === "playing" && s.turn === seat && !s.winnerId ? "turn" : "",
      out ? "out" : "",
      !p.cpu && !p.connected ? "offline" : "",
      p.id === s.winnerId ? "winner" : "",
    ].join(" ");
    const tags = [
      p.id === shell.me ? `<span class="tag tag-you">you</span>` : "",
      p.standIn ? `<span class="tag">CPU stand-in</span>` : p.cpu ? `<span class="tag">CPU · ${p.cpu}</span>` : "",
      !p.cpu && !p.connected && !out ? `<span class="tag">away</span>` : "",
    ].join("");
    const stats = out
      ? `Out in round ${p.outRound}`
      : `<b>${land}</b> land · group <b>${largestGroup(app.map!.adj, s.owner, seat)}</b> · <b>${sum(s.dice.filter((_, t) => s.owner[t] === seat))}</b> dice` +
        (p.reserve ? ` · <b>${p.reserve}</b> saved` : "");
    const hand =
      host && s.phase === "playing" && !p.cpu && !p.connected && !out
        ? `<button class="btn btn-small" data-takeover="${p.id}" title="A normal CPU plays for ${esc(p.name)} until they come back">CPU</button>`
        : "";
    return `<li class="${cls}">
      <span class="chip" style="background:${p.color}"></span>
      <span class="pname">${esc(p.name)}${tags}</span>${hand}
      <span class="pstats">${stats}</span>
    </li>`;
  });
  const watching = s.players.filter((p) => p.seat < 0);
  if (watching.length) rows.push(`<li class="watchers muted">Watching: ${watching.map((p) => esc(p.name)).join(", ")}</li>`);
  $("game-players").innerHTML = rows.join("");
}

function warn(text: string): void {
  app.warning = { text, until: performance.now() + 2600 };
  renderHint();
}

function renderHint(): void {
  const el = $("hint");
  const s = shell.state;
  if (!s || s.phase === "lobby") return;
  let text = "";
  let cls = "";
  if (app.warning.until) {
    text = app.warning.text;
    cls = "warn";
  } else {
    text = hintText(s);
  }
  if (el.textContent !== text) el.textContent = text;
  el.className = `hint-line ${cls}`;
}

function hintText(s: GameState): string {
  const me = mine(s);
  const touch = matchMedia("(pointer: coarse)").matches;
  const pick = touch ? "Tap" : "Click";
  if (s.phase === "gameover") return "Game over.";
  if (s.winnerId) return `${shell.player(s.winnerId)?.name ?? "Someone"} holds every territory.`;
  if (!me || me.seat < 0) return "You're watching this game. You'll get a seat in the next one.";
  if (me.outRound !== null) return "You're out. Watch the rest, or chat while they finish.";
  const turn = seatPlayer(s, s.turn);
  if (s.timer?.kind === "drop") return s.order[s.turn] === shell.me ? "Your new dice are landing…" : `${turn?.name ?? "Their"} new dice are landing…`;
  if (!isMyTurn(s)) {
    if (!turn) return "";
    if (turn.cpu) return `${turn.name} is attacking…`;
    return turn.connected ? `Waiting for ${turn.name}.` : `${turn.name} isn't here; their turn ends in a few seconds.`;
  }
  if (!app.map) return "";
  if (!legalAttacks(app.map.adj, s.owner, s.dice, me.seat).length) return "No attacks left: end your turn to collect your dice.";
  if (app.selected >= 0) return `${pick} a highlighted neighbour to attack, or ${pick.toLowerCase()} this territory again to cancel.`;
  return `${pick} one of your territories with 2+ dice, then a neighbour to attack.${touch ? "" : " Enter ends your turn."}`;
}

const PIPS: Record<number, [number, number][]> = {
  1: [[2, 2]],
  2: [[1, 1], [3, 3]],
  3: [[1, 1], [2, 2], [3, 3]],
  4: [[1, 1], [3, 1], [1, 3], [3, 3]],
  5: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]],
  6: [[1, 1], [3, 1], [1, 2], [3, 2], [1, 3], [3, 3]],
};

function dieHtml(face: number, color: string): string {
  const pips = PIPS[face].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="0.45"/>`).join("");
  return `<i class="die" style="--c:${color}"><svg viewBox="0 0 4 4" aria-hidden="true">${pips}</svg></i>`;
}

function renderRollbar(): void {
  const el = $("rollbar");
  const s = shell.state;
  const roll = app.anim?.kind === "attack" ? app.anim.roll : app.lastRoll;
  if (!s || !roll) {
    el.innerHTML = `<span class="muted">Rolls show up here.</span>`;
    el.setAttribute("aria-label", "");
    return;
  }
  const a = app.anim?.kind === "attack" ? app.anim : null;
  const tumbling = !!a && !a.revealed;
  const colors = seatColors(s);
  const side = (rolls: number[], color: string) =>
    rolls.map((v) => dieHtml(tumbling ? 1 + Math.floor(Math.random() * 6) : v, color)).join("");
  const { ev } = roll;
  const att = sum(ev.att);
  const def = sum(ev.def);
  const attName = seatPlayer(s, ev.seat)?.name ?? "?";
  const defName = seatPlayer(s, roll.defSeat)?.name ?? "?";
  const result = tumbling ? "" : ev.won ? "win" : "lose";
  el.className = `rollbar ${result}`;
  el.innerHTML = `
    <div class="roll-side att"><span class="dice">${side(ev.att, colors[ev.seat])}</span><b class="total">${tumbling ? "…" : att}</b></div>
    <span class="vs">vs</span>
    <div class="roll-side def"><b class="total">${tumbling ? "…" : def}</b><span class="dice">${side(ev.def, colors[roll.defSeat])}</span></div>`;
  el.setAttribute(
    "aria-label",
    tumbling ? `${attName} attacks ${defName}` : `${attName} rolled ${att} against ${defName}'s ${def}: ${ev.won ? "captured" : "held"}`,
  );
}

function flashBanner(html: string, ms: number): void {
  app.bannerUntil = performance.now() + ms;
  const el = $("banner");
  el.innerHTML = html;
  el.hidden = false;
}

function renderBanner(s: GameState): void {
  const el = $("banner");
  if (s.phase === "playing" && s.winnerId) {
    const w = shell.player(s.winnerId);
    el.innerHTML = `<span class="big" style="color:${w?.color}">${esc(w?.name ?? "?")}</span>conquers the map!`;
    el.hidden = false;
    return;
  }
  if (app.bannerUntil) return;
  el.hidden = true;
}

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover";
  $("gameover").hidden = !open;
  if (!open) return;
  const ranked = standings(s);
  const best = shell.player(s.winnerId);
  $("gameover-winner").innerHTML = best ? `<b style="color:${best.color}">${esc(best.name)}</b> rules the map.` : "";
  $("gameover-rows").innerHTML = ranked
    .map(
      (p, i) => `<tr class="${p.id === s.winnerId ? "winner" : ""}">
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${p.color}"></span>${esc(p.name)}</span></td>
        <td>${p.id === s.winnerId ? "Winner" : p.outRound !== null ? `Round ${p.outRound}` : "—"}</td>
        <td>${p.captures}</td><td>${p.peak}</td></tr>`,
    )
    .join("");
  const back = $<HTMLButtonElement>("gameover-lobby");
  const host = shell.canHost(s);
  back.disabled = !host;
  back.textContent = host ? "Back to lobby" : `Waiting for ${shell.player(s.hostId)?.name ?? "the host"}…`;
}

// ------------------------------------------------------------------ playing

function tap(t: number): void {
  unlockAudio();
  const s0 = shell.state;
  if (!s0 || s0.phase !== "playing" || !app.map) return;
  // A tap skips the roll or dice animation, so you can play on at your own pace.
  if (app.anim) skipAnims();
  const s = shell.state!;
  const me = mine(s);
  const { owner, dice } = app.board;
  const adj = app.map.adj;
  if (t < 0) {
    deselect();
    return;
  }
  if (!me || me.seat < 0 || me.outRound !== null) return;
  if (!isMyTurn(s)) {
    if (s.winnerId || s.timer?.kind === "drop") return;
    return warn(`It's ${seatPlayer(s, s.turn)?.name ?? "someone else"}'s turn.`);
  }
  if (app.pending) return;
  const yours = owner[t] === me.seat;
  if (app.selected >= 0) {
    if (t === app.selected) return deselect();
    if (!yours) {
      if (adj[app.selected].includes(t)) return attack(app.selected, t);
      return warn("You can only attack a territory next to the selected one.");
    }
  }
  if (!yours) return warn(`That's ${seatPlayer(s, owner[t])?.name ?? "an enemy"}'s. Pick one of yours with 2 or more dice first.`);
  if (dice[t] < 2) return warn("Only 1 die here: a territory needs 2 or more dice to attack.");
  if (!targetsOf(adj, owner, dice, t).length) return warn("No enemy territory next to this one.");
  sfx.click();
  app.selected = t;
  app.dirty = true;
  renderHint();
}

function deselect(): void {
  if (app.selected < 0) return;
  app.selected = -1;
  app.dirty = true;
  renderHint();
}

let pendingWatchdog = 0;

function attack(from: number, to: number): void {
  if (!shell.send({ t: "attack", from, to })) {
    toast("Not connected — reconnecting, try again in a moment");
    return;
  }
  app.pending = true;
  clearTimeout(pendingWatchdog);
  pendingWatchdog = window.setTimeout(() => {
    if (!app.pending) return;
    app.pending = false;
    toast("The server didn't answer — try again");
  }, 6000);
}

function endTurn(): void {
  if (!isMyTurn()) return;
  if (app.anim) skipAnims();
  if (!shell.send({ t: "end" })) {
    toast("Not connected — reconnecting, try again in a moment");
    return;
  }
  app.selected = -1;
  app.dirty = true;
}

// ------------------------------------------------------------------ layout & wiring

function layoutStage(): void {
  const stage = $("stage");
  const width = stage.clientWidth;
  if (!width) return;
  const aspect = app.map ? view.aspect : 1;
  const narrow = window.innerWidth <= 760;
  // Keep the roll bar and hint on screen under the map on a desktop; on a phone, let it scroll.
  const top = stage.getBoundingClientRect().top + window.scrollY;
  const maxH = narrow ? window.innerHeight * 0.75 : window.innerHeight - top - 120;
  view.resize(width, Math.max(240, Math.min(width / aspect, maxH)));
  app.dirty = true;
}

function wire(): void {
  window.addEventListener("resize", () => (shell.screen === "home" ? attract.resize() : layoutStage()));
  let lastWidth = 0;
  new ResizeObserver(() => {
    const w = $("stage").clientWidth;
    if (shell.screen === "game" && w !== lastWidth) {
      lastWidth = w;
      layoutStage();
    }
  }).observe($("stage"));

  const canvas = view.canvas;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    tap(view.hit(e.clientX, e.clientY));
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const t = view.hit(e.clientX, e.clientY);
    if (t !== app.hover) {
      app.hover = t;
      app.dirty = true;
    }
  });
  canvas.addEventListener("pointerleave", () => {
    app.hover = -1;
    app.dirty = true;
  });
  $("rollbar").addEventListener("pointerdown", () => app.anim && skipAnims());

  $("end-turn").addEventListener("click", (e) => {
    endTurn();
    // Hand the keyboard back to the game, or Enter would press this button again.
    (e.currentTarget as HTMLElement).blur();
  });
  $("fast").addEventListener("click", (e) => {
    shell.send({ t: "fast", on: !shell.state?.settings.fastCpus });
    (e.currentTarget as HTMLElement).blur();
  });
  $("game-players").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-takeover]");
    if (!btn) return;
    shell.send({ t: "takeover", id: btn.dataset.takeover! });
    btn.blur();
  });

  window.addEventListener("keydown", (e) => {
    if (shell.screen !== "game") return;
    const target = e.target as HTMLElement;
    if (target.closest("input, select, textarea")) return;
    if (e.key === "Escape") deselect();
    // A focused button owns Enter.
    if (e.key === "Enter" && !target.closest("button") && isMyTurn()) {
      e.preventDefault();
      endTurn();
    }
  });
}

wire();
shell.start();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __dd: { app, view, shell } });
