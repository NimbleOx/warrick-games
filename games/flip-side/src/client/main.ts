import { unlockAudio } from "@warrick/kit/client/audio";
import { $, $$, esc, personalBest, setHtml, setText } from "@warrick/kit/client/dom";
import { formatClock } from "@warrick/kit/client/format";
import { Feed } from "@warrick/kit/client/hud";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { randomSeed } from "@warrick/kit/shared/rng";
import { Pilot } from "../shared/ai";
import { PLAYER_COLORS, SEND_MS, TICK_HZ } from "../shared/constants";
import {
  F_AWAY,
  F_OVER,
  SETTING_CHOICES,
  TROUBLE_HELP,
  TROUBLE_NAMES,
  emptyView,
  formatScore,
  ordinal,
  viewOf,
  type Aim,
  type ClientMsg,
  type GameState,
  type MatchSnapshot,
  type PlayerState,
  type ServerMsg,
  type Settings,
  type Trouble,
  type View,
} from "../shared/protocol";
import {
  AUTO_TICKS,
  B_OFF,
  B_PLUNGER,
  DANGER_TICKS,
  EV_BANK,
  EV_BONUS,
  EV_BUMPER,
  EV_DRAIN,
  EV_DROP,
  EV_EJECT,
  EV_FLIP,
  EV_HIT,
  EV_INLANE,
  EV_JACKPOT,
  EV_KICK,
  EV_LANE,
  EV_LANES,
  EV_LAUNCH,
  EV_LOCK,
  EV_LOST,
  EV_MULTIBALL,
  EV_NUDGE,
  EV_ORBIT,
  EV_OUTLANE,
  EV_OVER,
  EV_SAVED,
  EV_SCOOP,
  EV_SEND,
  EV_SERVE,
  EV_SKILL,
  EV_SLING,
  EV_TARGET,
  EV_TARGETS,
  EV_TILT,
  EV_WARN,
  POWER_MAX,
  TILT_AT,
  TROUBLE_TICKS,
  type Mode,
  type Play,
} from "../shared/sim";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { Controls } from "./input";
import { ClientMatch, DELAY } from "./match";
import { TableRenderer } from "./render";

// ------------------------------------------------------------------ app state

const app = {
  match: null as ClientMatch | null,
  /** The state being applied came with a welcome (joining or reconnecting), not a change of phase. */
  welcomed: false,
  /** When this screen last sent its inputs. */
  sentAt: 0,
  /** When it last asked the room for its game (it asks at most once a second). */
  resyncAt: 0,
  /** When the last animation frame ran. */
  lastNow: 0,
  /** When the results first covered the table (0: they don't). */
  coveredAt: 0,
  /** Whose table the big view shows when you're not playing (null: the leader). */
  watch: null as string | null,
  /** A message in the banner for a moment. */
  flash: null as { html: string; until: number; cls: string } | null,
  /** The last countdown second shown, for its beep. */
  lastCount: 0,
  /** Your score against your best (solo), for the results. */
  best: null as { best: number; prev: number | null; fresh: boolean } | null,
  /** Trouble already announced, by id. */
  heard: new Set<number>(),
  /** When the rivals' tables, and their scores, were last redrawn. */
  rivalsAt: 0,
  rivalTextAt: 0,
  /** When this screen first saw your game over (balls): a moment later, the big view watches the others. */
  overAt: 0,
  /** A dev aid: a CPU plays your table. */
  autopilot: null as Pilot | null,
};

/** No animation frame for this long (ms): the page isn't animating (a hidden tab or pane). */
const STILL_MS = 250;
/** How long the table goes on drawing under the results (ms). */
const SETTLE_MS = 600;

const MODES: Record<Mode, string> = { timed: "Timed — top score wins", balls: "Balls — so many each" };
const AIMS: Record<Aim, string> = { random: "A random rival", leader: "Whoever's winning", off: "Nobody (no trouble)" };

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "flip-side",
  title: "Flip Side",
  prefix: "fs",
  logo: "FLIP<br />SIDE",
  tagline: "Pinball against your friends.<br />No accounts — just share a code.",
  placeholder: "Player",
  footer: "Everyone plays the same table. Big shots send trouble to your rivals.",
  playersLabel: "Players",
  colors: PLAYER_COLORS,
  minPlayers: 1,
  soloLabel: "Play solo",
  rules: [
    "Everyone plays the same table at once, each on their own screen.",
    "Big shots — drop targets, lanes, orbits, jackpots — charge your trouble meter. Full, and a brick, fog, shrunk flippers or swapped buttons land on a rival.",
    "Timed: top score when time's up wins. Balls: top score once everyone's drained wins.",
    "Drop targets light the scoop: lock two balls for multiball, then shoot the scoop for jackpots.",
  ],
  soloRules: [
    "Just you and the table: play for your best score.",
    "Drop targets light the scoop: lock two balls for multiball, then shoot the scoop for jackpots.",
    "Your best score for each mode is kept in this browser.",
  ],
  settings: {
    mode: { label: "Match", fmt: (v: Mode) => MODES[v] ?? v },
    minutes: { label: "Time", fmt: (v: number) => `${v} minutes`, when: (s: Settings) => s.mode === "timed" },
    balls: { label: "Balls", fmt: (v: number) => `${v} balls each`, when: (s: Settings) => s.mode === "balls" },
    trouble: { label: "Trouble goes to", fmt: (v: Aim) => AIMS[v] ?? v },
  },
  choices: SETTING_CHOICES,
  onWelcome,
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s): string | null => (isLive(s) ? "Leave this game? Your table comes out of the match." : null),
  isLive: (s) => isLive(s),
});

const renderer = new TableRenderer($<HTMLCanvasElement>("table-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));
const controls = new Controls(onKey);
const feed = new Feed("feed");
const coarse = window.matchMedia("(pointer: coarse)");
const minis = new Map<string, TableRenderer>();
const myView = emptyView();

const serverNow = () => shell.serverNow();
const playerById = (id: string | null | undefined): PlayerState | undefined => shell.player(id);
const nameOf = (id: string) => esc(playerById(id)?.name ?? "Someone");
const colorOf = (id: string) => playerById(id)?.color ?? "#ffffff";

function isLive(s = shell.state): boolean {
  return !!s && (s.phase === "countdown" || s.phase === "playing");
}

/** The match on screen, if it's the state's. */
function currentMatch(s = shell.state): ClientMatch | null {
  const m = app.match;
  return m && s && m.run === s.run ? m : null;
}

/** The match clock now, in ticks (and fractions of one). */
function clockNow(s: GameState): number {
  return s.startAt === null ? 0 : ((serverNow() - s.startAt) * TICK_HZ) / 1000;
}

/** Whether the balls are moving: playing, or the countdown is done and the state saying so is on its way. */
function underway(s: GameState): boolean {
  return s.phase === "playing" || (s.phase === "countdown" && s.phaseDeadline !== null && serverNow() >= s.phaseDeadline);
}

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "home") attract.resize();
  if (screen === "game") {
    renderer.resize();
    // The lobby's start button keeps the focus as its screen goes: give the keys to the game.
    const active = document.activeElement;
    if (active instanceof HTMLElement && !$("screen-game").contains(active)) active.blur();
  }
  if (screen !== "game") controls.enabled = false;
}

/** Left the game, or lost it for good. */
function onReset(): void {
  app.match = null;
  app.watch = null;
  app.heard.clear();
  $("results").hidden = true;
  feed.clear();
  renderer.reset();
}

function onWelcome(msg: ServerMsg): void {
  if (msg.t !== "welcome") return;
  app.welcomed = true;
  setMatch(msg.match);
}

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case "match":
      setMatch(msg.match);
      break;
    case "frame":
      onFrame(msg);
      break;
    case "sync": {
      const m = app.match;
      if (m?.mine && m.run === msg.run) m.mine.adopt(msg.play, msg.bits);
      break;
    }
    case "trouble":
      onTrouble(msg.run, msg.tr);
      break;
  }
}

function setMatch(snap: MatchSnapshot | null): void {
  if (!snap) {
    app.match = null;
    return;
  }
  const fresh = app.match?.run !== snap.run;
  app.match = new ClientMatch(snap, shell.me, app.match);
  if (fresh) {
    renderer.reset();
    feed.clear();
    app.heard.clear();
    for (const tr of snap.troubles) app.heard.add(tr.id);
    buildRivals();
  }
}

function onFrame(msg: Extract<ServerMsg, { t: "frame" }>): void {
  const m = app.match;
  if (!m || m.run !== msg.run) return;
  const ok = m.frame(msg.k, msg.r, shell.me);
  // Our game isn't what the room has: ask for the room's (once a second at most).
  if (!ok) resync();
}

function resync(): void {
  const m = app.match;
  if (!m || performance.now() - app.resyncAt < 1000) return;
  app.resyncAt = performance.now();
  shell.send({ t: "resync", run: m.run });
}

function onTrouble(run: number, tr: Trouble): void {
  const m = app.match;
  if (!m || m.run !== run) return;
  if (!m.trouble(tr, shell.me)) resync();
  if (app.heard.has(tr.id)) return;
  app.heard.add(tr.id);
  const name = TROUBLE_NAMES[tr.kind];
  if (tr.to === shell.me) {
    sfx.incoming();
    feed.push(`<b style="color:${colorOf(tr.from)}">${nameOf(tr.from)}</b> sent you <b class="bad">${name}</b>`);
  } else if (tr.from === shell.me) {
    feed.push(`Your <b class="good">${name}</b> is on its way to <b style="color:${colorOf(tr.to)}">${nameOf(tr.to)}</b>`);
  } else {
    feed.push(
      `<b style="color:${colorOf(tr.from)}">${nameOf(tr.from)}</b> → <b style="color:${colorOf(tr.to)}">${nameOf(tr.to)}</b>: ${name}`,
    );
  }
}

/** The shell has shown the lobby or the game screen (and drawn the lobby). */
function onState(s: GameState, prev: GameState | null): void {
  const welcomed = app.welcomed;
  app.welcomed = false;
  if (s.phase === "lobby") app.match = null;
  if (prev && !welcomed && s.phase === "results" && prev.phase !== "results") {
    const mine = s.results?.rows.find((r) => r.id === shell.me);
    if (mine?.place === 1 && !s.results?.solo && mine.score > 0) sfx.win();
    noteBest(s);
  }
  if (s.phase !== "results") app.best = null;
  buildRivals();
  render();
}

/** After a solo match: your score against your best for the mode. */
function noteBest(s: GameState): void {
  const res = s.results;
  const mine = res?.rows.find((r) => r.id === shell.me);
  app.best = null;
  if (!res?.solo || !mine) return;
  const set = s.settings;
  const key = res.mode === "timed" ? `best.timed.${set.minutes}` : `best.balls.${set.balls}`;
  app.best = personalBest(key, `${s.code}:${s.run}`, mine.score);
}

// ------------------------------------------------------------------ the loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  app.lastNow = now;
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game") return;
  step(now);
  // Under the results, whose blurred backdrop the browser would redo for every frame drawn
  // beneath it, the tables keep their last frame (unless a resize wiped one).
  const covered = !$("results").hidden;
  app.coveredAt = covered ? app.coveredAt || now : 0;
  if (!covered || now - app.coveredAt < SETTLE_MS || renderer.blank) draw(now);
  hud(now);
}

/** Steps your table to the clock and sends your inputs. */
function step(now: number): void {
  const s = shell.state;
  const m = currentMatch(s);
  const mine = m?.mine ?? null;
  controls.enabled = !!s && !!mine && isLive(s) && !mine.play.over;
  if (!s || !m || !mine || !isLive(s) || !underway(s)) return;
  const target = Math.floor(clockNow(s));
  const pilot = app.autopilot;
  const read = pilot ? () => pilot.decide(mine.play, mine.table, mine.rules) : () => controls.read();
  m.advance(target, read, (p) => myEvents(p, now));
  controls.settle();
  if (now - app.sentAt >= SEND_MS) {
    const msg = mine.message();
    if (shell.send(msg)) mine.sent(msg);
    app.sentAt = now;
  }
}

/** What happened on your table this tick: sounds, lights, popups and the banner. */
function myEvents(p: Play, now: number): void {
  for (const e of p.events) {
    const pts = e.pts ? `+${formatScore(e.pts)}` : "";
    switch (e.k) {
      case EV_FLIP:
        sfx.flipper();
        break;
      case EV_BUMPER:
        sfx.bumper(e.i);
        renderer.flash(e.i);
        break;
      case EV_SLING:
        sfx.sling();
        renderer.flash(3 + e.i);
        break;
      case EV_HIT:
        sfx.hit();
        break;
      case EV_DROP:
        sfx.drop();
        renderer.popup(e.x, e.y, pts, "#ff8a2f");
        break;
      case EV_BANK:
        sfx.bank();
        renderer.popup(e.x, e.y - 24, pts, "#ffe14d");
        feed.push(`Drop targets down: <b>${pts}</b>${p.multi ? "" : " · lock lit"}`);
        break;
      case EV_TARGET:
        sfx.target();
        renderer.flash(5 + e.i);
        break;
      case EV_TARGETS:
        sfx.bank();
        renderer.popup(e.x - 40, e.y, pts, "#2fd6ff");
        feed.push(`Standups complete: <b>${pts}</b>`);
        break;
      case EV_LANE:
        sfx.lane();
        break;
      case EV_LANES:
        sfx.lanes();
        renderer.popup(e.x, e.y + 60, `${e.i}×`, "#ffe14d");
        feed.push(`Lanes complete: bonus <b>${e.i}×</b>`);
        break;
      case EV_ORBIT:
        sfx.orbit(e.i);
        renderer.popup(110, 300, e.i > 1 ? `COMBO ${e.i}× ${pts}` : pts, "#39e6ff");
        break;
      case EV_SCOOP:
        sfx.scoop();
        renderer.popup(e.x - 30, e.y + 40, pts, "#ffffff");
        break;
      case EV_EJECT:
        sfx.eject();
        break;
      case EV_LOCK:
        sfx.lock();
        flash(`<span class="big">BALL ${e.i} LOCKED</span>One more for multiball`, 1600, "good");
        break;
      case EV_MULTIBALL:
        sfx.multiball();
        flash(`<span class="big">MULTIBALL!</span>Shoot the scoop for jackpots`, 2200, "good");
        feed.push(`<b class="good">Multiball!</b>`);
        break;
      case EV_JACKPOT:
        sfx.jackpot();
        flash(`<span class="big">JACKPOT!</span>${pts}`, 1800, "good");
        feed.push(`<b class="good">Jackpot</b> ${pts}`);
        break;
      case EV_SKILL:
        sfx.skill();
        flash(`<span class="big">SKILL SHOT!</span>${pts}`, 1600, "good");
        break;
      case EV_LAUNCH:
        sfx.launch();
        break;
      case EV_SAVED:
        sfx.saved();
        flash(`<span class="big">BALL SAVED</span>`, 1200, "good");
        break;
      case EV_LOST:
        sfx.lost();
        break;
      case EV_DRAIN:
        sfx.drain();
        break;
      case EV_BONUS:
        sfx.bonus();
        flash(`<span class="big">BONUS</span>${formatScore(e.pts / e.i)} × ${e.i} = ${formatScore(e.pts)}`, 1800, "");
        break;
      case EV_SERVE:
        if (e.i > 1) flash(`<span class="big">BALL ${e.i}</span>${ballLine(p)}`, 1300, "");
        break;
      case EV_OUTLANE:
        renderer.popup(e.x, e.y - 20, pts, "#ff7ad9");
        break;
      case EV_INLANE:
        break;
      case EV_SEND:
        sfx.send();
        flash(`<span class="big">TROUBLE SENT!</span>`, 1100, "good");
        break;
      case EV_NUDGE:
        sfx.nudge();
        $("stage").classList.remove("shake");
        void $("stage").offsetWidth;
        $("stage").classList.add("shake");
        break;
      case EV_WARN:
        sfx.warn();
        flash(`<span class="big">TILT WARNING</span>One more nudge and it's a tilt`, 1600, "bad");
        break;
      case EV_TILT:
        sfx.tilt();
        flash(`<span class="big">TILT!</span>Flippers dead until the ball drains · no bonus`, 2400, "bad");
        break;
      case EV_KICK:
        break;
      case EV_OVER:
        sfx.over();
        break;
    }
  }
  // Trouble landing on this tick.
  const prev = app.match?.mine?.prev;
  if (prev) {
    for (let k = 0; k < TROUBLE_TICKS.length; k++) {
      if (p.trouble[k] > prev.trouble[k] + 1) {
        sfx.trouble();
        flash(`<span class="big">${TROUBLE_NAMES[k].toUpperCase()}!</span>${TROUBLE_HELP[k]}`, 1400, "bad");
      }
    }
  }
  void now;
}

function flash(html: string, ms: number, cls: string): void {
  app.flash = { html, until: performance.now() + ms, cls };
}

function ballLine(p: Play): string {
  if (!p.limited) return "";
  const total = app.match?.rules.balls ?? 3;
  return p.left === 0 ? "Last ball!" : `of ${total}`;
}

// ------------------------------------------------------------------ drawing

/** Who the big view shows when you're not playing: your pick, or the leader still playing. */
function watching(m: ClientMatch): string | null {
  if (app.watch && m.ghosts.has(app.watch)) return app.watch;
  let best: string | null = null;
  let bestScore = -1;
  for (const [id, g] of m.ghosts) {
    const v = g.latest;
    if (!v) continue;
    const score = v.flags & F_OVER ? v.score - 1e12 : v.score;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/** Whether the big view is your own table. */
function showingMine(m: ClientMatch | null): boolean {
  const mine = m?.mine;
  if (!mine) return false;
  // Once your game is over (balls) and a moment has passed, watch the others.
  if (!mine.play.over) {
    app.overAt = 0;
    return true;
  }
  const now = performance.now();
  app.overAt ||= now;
  return now - app.overAt < 3000 || m.ghosts.size === 0;
}

function draw(now: number): void {
  const s = shell.state;
  const m = app.match;
  if (!s) return;
  renderer.resize();
  const ft = underway(s) ? clockNow(s) : 0;
  if (m && showingMine(m)) {
    renderer.draw(myViewAt(m, ft), colorOf(shell.me), now);
  } else if (m) {
    const id = watching(m);
    const v = id ? m.ghosts.get(id)?.at(ft - DELAY) : null;
    renderer.draw(v ?? emptyView(), id ? colorOf(id) : "#ffffff", now);
  } else renderer.draw(emptyView(), colorOf(shell.me), now);
  if (now - app.rivalsAt > 33) {
    app.rivalsAt = now;
    drawRivals(m, ft);
  }
}

/** Your table a tick behind clock time `ft`, between its last two ticks, so it moves smoothly. */
function myViewAt(m: ClientMatch, ft: number): View {
  const mine = m.mine!;
  const p = mine.play;
  const q = mine.prev;
  viewOf(p, myView);
  const a = Math.max(0, Math.min(1, ft - p.tick));
  if (q.tick !== p.tick - 1 || a >= 1) return myView;
  myView.balls.length = 0;
  for (let i = 0; i < p.balls.length; i++) {
    const b = p.balls[i];
    const c = q.balls[i];
    if (b.st === B_OFF) continue;
    if (c.st === B_OFF) myView.balls.push({ x: b.x, y: b.y });
    else myView.balls.push({ x: c.x + (b.x - c.x) * a, y: c.y + (b.y - c.y) * a });
  }
  myView.flip[0] = q.flip[0] + (p.flip[0] - q.flip[0]) * a;
  myView.flip[1] = q.flip[1] + (p.flip[1] - q.flip[1]) * a;
  return myView;
}

/** The rivals' cards: built again when who's in the match, or their names or colours, change. */
function buildRivals(): void {
  const s = shell.state;
  const m = app.match;
  const ids = (m?.seats ?? s?.seats ?? []).filter((id) => id !== shell.me || !m?.mine);
  const key = ids.map((id) => `${id}:${playerById(id)?.name}:${colorOf(id)}`).join("|");
  if ($("rivals").dataset.key === key && minis.size === ids.length) return;
  $("rivals").dataset.key = key;
  minis.clear();
  setHtml(
    $("rivals"),
    ids.length
      ? ids
          .map(
            (id) => `<button class="rival" data-watch="${id}" title="Watch ${nameOf(id)}">
              <canvas></canvas>
              <span class="rival-name"><span class="chip" style="background:${colorOf(id)}"></span><span class="pname">${nameOf(id)}</span></span>
              <span class="rival-score" data-score></span>
              <span class="rival-status" data-status></span>
            </button>`,
          )
          .join("")
      : `<p class="hint">No rivals: it's just you and the table.</p>`,
  );
  for (const el of $$<HTMLElement>("#rivals .rival")) {
    minis.set(el.dataset.watch!, new TableRenderer(el.querySelector("canvas")!, true));
  }
}

function drawRivals(m: ClientMatch | null, ft: number): void {
  for (const [id, mini] of minis) {
    const g = m?.ghosts.get(id);
    const v = g?.at(ft - DELAY);
    mini.resize();
    if (v) mini.draw(v, colorOf(id));
    else if (mini.blank) mini.draw(emptyView(), colorOf(id));
  }
}

// ------------------------------------------------------------------ HUD

function hud(now: number): void {
  const s = shell.state;
  if (!s) return;
  const m = currentMatch(s);
  const mine = m?.mine?.play ?? null;
  const showMine = !!m && showingMine(m);
  const watchId = m && !showMine ? watching(m) : null;
  const view: View | null =
    showMine && mine ? viewOf(mine, emptyView()) : watchId ? (m!.ghosts.get(watchId)?.latest ?? null) : null;
  const tick = underway(s) ? Math.max(0, Math.floor(clockNow(s))) : 0;
  const rules = m?.rules;

  setHtml($("hud-who"), watchId ? `Watching <b style="color:${colorOf(watchId)}">${nameOf(watchId)}</b>` : "");
  setText($("hud-score"), formatScore(view?.score ?? (s.phase === "results" ? (myResult(s)?.score ?? 0) : 0)));
  let ball = "";
  if (view && rules) {
    if (rules.mode === "balls")
      ball =
        view.flags & F_OVER ? "Game over" : view.left === 0 ? `Ball ${view.ball} · last` : `Ball ${view.ball} of ${rules.balls}`;
    else ball = `Ball ${view.ball}`;
  }
  setText($("hud-ball"), ball);
  const clock = rules && isLive(s) ? Math.max(0, rules.endTick - tick) : null;
  const clockText =
    clock === null
      ? ""
      : rules!.mode === "timed"
        ? formatClock((clock * 1000) / TICK_HZ)
        : clock < 60 * TICK_HZ
          ? `cap ${formatClock((clock * 1000) / TICK_HZ)}`
          : "";
  setText($("hud-clock"), clockText);
  $("hud-clock").classList.toggle("low", rules?.mode === "timed" && clock !== null && clock < 15 * TICK_HZ);
  setText($("hud-mult"), view ? `Bonus ${view.mult}×` : "");
  setText($("hud-save"), mine && showMine && mine.save > 0 ? `Ball save ${Math.ceil(mine.save / TICK_HZ)}` : "");

  // The trouble meter.
  const solo = !!m && m.seats.length === 1;
  const off = s.settings.trouble === "off";
  $("power-panel").hidden = solo || off || !m;
  const power = view?.power ?? 0;
  const pips = Array.from({ length: POWER_MAX }, (_, i) => `<i class="${i < power ? "on" : ""}"></i>`).join("");
  setHtml($("power"), pips);
  setText($("power-to"), s.settings.trouble === "leader" ? "→ whoever's winning" : "→ a random rival");
  setHtml($("mini-power"), solo || off ? "" : pips);
  setText($("mini-score"), formatScore(view?.score ?? 0));
  setText($("mini-ball"), [ball, clockText].filter(Boolean).join(" · "));

  renderStatus(s, m, mine, showMine, tick);
  renderBanner(s, m, now);
  feed.age(now);
  $("pad").hidden = !coarse.matches || !mine || !isLive(s) || !!mine.over || !showMine;
  const launch = $("pad").querySelector<HTMLElement>("[data-ctl=plunge]")!;
  launch.classList.toggle("ready", !!mine?.balls.some((b) => b.st === B_PLUNGER));
  if (now - app.rivalTextAt > 250) {
    app.rivalTextAt = now;
    renderRivalText(s, m);
  }
}

function myResult(s: GameState) {
  return s.results?.rows.find((r) => r.id === shell.me);
}

/** What's lit, what's coming and what's on you, as lines beside the table. */
function renderStatus(s: GameState, m: ClientMatch | null, p: Play | null, showMine: boolean, tick: number): void {
  const lines: string[] = [];
  if (p && m && showMine && isLive(s)) {
    // Trouble on its way, then trouble on you.
    for (const tr of m.mine!.troubles) {
      if (tr.at <= p.tick || tr.at - p.tick > 3 * TICK_HZ) continue;
      lines.push(
        `<li class="bad">⚠ <b>${TROUBLE_NAMES[tr.kind]}</b> from <span style="color:${colorOf(tr.from)}">${nameOf(tr.from)}</span> in ${((tr.at - p.tick) / TICK_HZ).toFixed(1)} s</li>`,
      );
    }
    for (let k = 0; k < TROUBLE_TICKS.length; k++) {
      const left = p.trouble[k];
      if (left <= 0) continue;
      const pct = (100 * left) / TROUBLE_TICKS[k];
      lines.push(
        `<li class="bad"><b>${TROUBLE_NAMES[k]}</b>: ${TROUBLE_HELP[k]} · ${Math.ceil(left / TICK_HZ)} s<span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span></li>`,
      );
    }
    if (p.tilted) lines.push(`<li class="bad"><b>TILT</b>: flippers dead until the ball drains</li>`);
    else if (p.danger >= TILT_AT - 1)
      lines.push(`<li class="bad">Tilt warning: one more nudge in ${Math.ceil(p.dangerT / TICK_HZ)} s tilts</li>`);
    else if (p.danger > 0) lines.push(`<li>Nudged: ${TILT_AT - p.danger} more within ${DANGER_TICKS / TICK_HZ} s tilts</li>`);
    const plunger = p.balls.find((b) => b.st === B_PLUNGER);
    if (plunger && plunger.t < AUTO_TICKS / 2) {
      if (p.skill >= 0) lines.push(`<li class="good">Skill shot: plunge into the flashing lane</li>`);
      const left = AUTO_TICKS - plunger.t;
      if (left < 5 * TICK_HZ) lines.push(`<li>Launches itself in ${Math.ceil(left / TICK_HZ)} s</li>`);
    }
    if (p.multi)
      lines.push(
        `<li class="good"><b>Multiball</b>${p.jackpot ? ": jackpot lit at the scoop" : ": orbit to relight the jackpot"}</li>`,
      );
    else if (p.lockLit) lines.push(`<li class="good">Lock lit: shoot the scoop (${p.locks}/2 locked)</li>`);
    else if (p.locks) lines.push(`<li>${p.locks}/2 locked: drop targets relight the lock</li>`);
    if (p.save > 0) lines.push(`<li class="good">Ball save: ${Math.ceil(p.save / TICK_HZ)} s</li>`);
    if (p.combo > 0 && p.comboT > 0)
      lines.push(`<li>Orbit combo ${p.combo}×: go again within ${Math.ceil(p.comboT / TICK_HZ)} s</li>`);
  } else if (m && !m.mine && isLive(s)) {
    const you = playerById(shell.me);
    lines.push(
      `<li>${you && !you.spectator ? "You'll play from the next match." : "You're watching."} Click a rival to watch them.</li>`,
    );
  }
  void tick;
  setHtml($("status"), lines.join(""));
  // On a phone the list is under the table: the most urgent line goes over it too.
  const alert = lines.find((l) => l.startsWith(`<li class="bad">`));
  const el = $("stage-alert");
  el.hidden = !alert;
  if (alert) setHtml(el, alert.replace(/^<li class="bad">|<\/li>$/g, "").replace(/<span class="bar">.*<\/span>/, ""));
}

function renderBanner(s: GameState, m: ClientMatch | null, now: number): void {
  const el = $("banner");
  const show = (html: string, cls = "") => {
    setHtml(el, html);
    el.className = `banner ${cls}`;
    el.hidden = false;
  };
  const mine = m?.mine?.play ?? null;
  if (s.phase === "countdown" && !underway(s)) {
    const secs = Math.max(1, Math.ceil(((s.phaseDeadline ?? 0) - serverNow()) / 1000));
    if (secs !== app.lastCount) {
      app.lastCount = secs;
      sfx.count();
    }
    const resuming = (mine?.tick ?? 0) > 0 || (m && m.frameTick > 0);
    const hint = !mine
      ? "You'll play from the next match"
      : resuming
        ? "Going on from where you were"
        : coarse.matches
          ? "Hold LAUNCH, let go to plunge"
          : "Hold ↓ or Space, let go to plunge";
    show(`<span class="count">${secs}</span>${hint}`);
    return;
  }
  if (app.lastCount) {
    app.lastCount = 0;
    if (isLive(s)) {
      sfx.go();
      flash(`<span class="count">GO!</span>`, 700, "");
    }
  }
  if (!isLive(s)) {
    el.hidden = true;
    return;
  }
  if (app.flash && now < app.flash.until) return show(app.flash.html, app.flash.cls);
  if (mine?.over && m && showingMine(m)) return show(`<span class="big">GAME OVER</span>${formatScore(mine.score)}`, "");
  el.hidden = true;
}

function renderRivalText(s: GameState, m: ClientMatch | null): void {
  for (const el of $$<HTMLElement>("#rivals .rival")) {
    const id = el.dataset.watch!;
    const v = m?.ghosts.get(id)?.latest;
    const row = s.results?.rows.find((r) => r.id === id);
    setText(el.querySelector<HTMLElement>("[data-score]")!, formatScore(v?.score ?? row?.score ?? 0));
    let status = "";
    if (v && m) {
      if (v.flags & F_OVER) status = "Game over";
      else if (v.flags & F_AWAY) status = "Away · autopilot";
      else status = m.rules.mode === "balls" ? `Ball ${v.ball}${v.left === 0 ? " · last" : ""}` : `Ball ${v.ball}`;
    }
    setText(el.querySelector<HTMLElement>("[data-status]")!, status);
    el.classList.toggle("watched", !!m && !showingMine(m) && watching(m) === id);
  }
  const n = minis.size;
  setText($("rivals-title"), n ? `Rivals (${n})` : "Rivals");
}

// ------------------------------------------------------------------ panels

function render(): void {
  const s = shell.state;
  if (!s || shell.screen !== "game") return;
  renderResults(s);
}

function renderResults(s: GameState): void {
  const open = s.phase === "results" && !!s.results;
  $("results").hidden = !open;
  if (!open) return;
  const res = s.results!;
  setText($("results-title"), res.solo ? "Your game" : `Match ${s.match}`);
  const top = res.rows[0];
  let line = "";
  if (res.solo) {
    const b = app.best;
    const score = top?.score ?? 0;
    if (b && b.fresh && b.prev !== null && b.best > b.prev)
      line = `<span class="best">New best!</span> ${formatScore(b.best)}, up from ${formatScore(b.prev)}.`;
    else if (b && b.prev === null) line = `Your first score in this mode: ${formatScore(score)}.`;
    else if (b) line = `${formatScore(score)}. Your best here is ${formatScore(b.best)}.`;
    else line = `${formatScore(score)}.`;
  } else if (top && top.score > 0) {
    const tied = res.rows.filter((r) => r.place === 1);
    line =
      tied.length > 1
        ? `A tie at ${formatScore(top.score)}: ${tied.map((r) => `<b style="color:${colorOf(r.id)}">${nameOf(r.id)}</b>`).join(" and ")}.`
        : `<b style="color:${colorOf(top.id)}">${nameOf(top.id)}</b> wins with ${formatScore(top.score)}.`;
  } else line = "Nobody scored.";
  setHtml($("results-line"), line);
  setHtml(
    $("results-rows"),
    res.rows
      .map((r) => {
        const p = playerById(r.id);
        return `<tr class="${r.place === 1 && !res.solo ? "winner" : ""} ${r.id === shell.me ? "you" : ""}">
          <td>${res.solo ? "" : ordinal(r.place)}</td>
          <td><span class="pcell"><span class="chip" style="background:${p?.color ?? "#888"}"></span>${esc(p?.name ?? "Gone")}</span></td>
          <td class="num">${formatScore(r.score)}</td><td class="num">${r.sent}</td><td class="num">${r.jackpots}</td><td class="num">${p?.wins ?? ""}</td></tr>`;
      })
      .join(""),
  );
  const host = shell.canHost(s);
  $("results-again").hidden = !host;
  $("results-lobby").hidden = !host;
  setText($("results-wait"), host ? "" : `Waiting for ${playerById(s.hostId)?.name ?? "the host"} to start the next match…`);
}

// ------------------------------------------------------------------ keys and buttons

function onKey(_code: string): void {
  if (shell.screen !== "game") return;
  unlockAudio();
}

function wire(): void {
  controls.wireTable($("stage"));
  controls.wireButtons($$("[data-ctl]"));
  $("stage").addEventListener("pointerdown", () => unlockAudio());
  $("pad").addEventListener("pointerdown", () => unlockAudio());
  $("rivals").addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-watch]")?.dataset.watch;
    if (!id) return;
    app.watch = app.watch === id ? null : id;
  });
  // Buttons on the game screen give the keys back to the game once clicked.
  $("screen-game").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b && !b.closest("form")) b.blur();
  });
  window.addEventListener("resize", () => {
    if (shell.screen === "game") renderer.resize();
  });
}

wire();
shell.start();
requestAnimationFrame(frame);

// A hidden tab or pane doesn't run animation frames: keep your table on the clock (and inputs
// going) from a timer.
setInterval(() => {
  const now = performance.now();
  if (shell.screen === "game" && now - app.lastNow > STILL_MS) {
    step(now);
    hud(now);
  }
}, 50);

if (import.meta.env.DEV) {
  Object.assign(window, {
    __fs: {
      app,
      shell,
      renderer,
      controls,
      /** Plays your table with a CPU ("easy", "normal", "hard"), or your hands again with null. */
      autopilot(level: CpuLevel | null) {
        app.autopilot = level ? new Pilot(level, randomSeed()) : null;
      },
    },
  });
}
