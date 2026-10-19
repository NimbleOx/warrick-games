import { unlockAudio } from "@warrick/kit/client/audio";
import { $, $$, esc, setHtml, setText, store } from "@warrick/kit/client/dom";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { Pilot } from "../shared/ai";
import { Bike } from "../shared/bike";
import { PLAYER_COLORS, RESPAWN_TICKS, SEND_MS, TICK_HZ } from "../shared/constants";
import { progressOf, type CourseLength, type Difficulty } from "../shared/course";
import {
  F_AWAY,
  F_CRASHED,
  F_FINISHED,
  SETTING_CHOICES,
  formatTicks,
  ordinal,
  rankPlayers,
  type ClientMsg,
  type GameState,
  type PlayerState,
  type RaceSnapshot,
  type ServerMsg,
} from "../shared/protocol";
import { Attract } from "./attract";
import { Engine, sfx } from "./audio";
import { DELAY, offerRun } from "./ghosts";
import { Controls } from "./input";
import type { RideInput } from "../shared/ride";
import { ClientRace, poseBetween, type MyEvent } from "./race";
import { Renderer, lookFor, type DrawBike } from "./render";

// ------------------------------------------------------------------ app state

const app = {
  race: null as ClientRace | null,
  /** The state being applied came with a welcome (joining or reconnecting), not a change of phase. */
  welcomed: false,
  /** When this screen last sent its inputs. */
  sentAt: 0,
  /** When it last asked the room for its bike (it asks at most once a second). */
  resyncAt: 0,
  /** When the last animation frame ran. */
  lastNow: 0,
  /** When the results first covered the course (0: they don't). */
  coveredAt: 0,
  /** Who the camera follows when you're not riding (null: the leader). */
  follow: null as string | null,
  /** A message in the banner for a moment (a checkpoint split, "GO!"). */
  flash: null as { html: string; until: number; cls: string } | null,
  /** The split at the last checkpoint, shown for a moment. */
  split: null as { html: string; until: number } | null,
  /** The last countdown second shown, for its beep. */
  lastCount: 0,
  /** When your bike last got anywhere, for the "stuck?" hint. */
  progressX: 0,
  progressAt: 0,
  /** Your result on the last course: whether it was a new best, for the results. */
  best: null as { best: number; prev: number | null; fresh: boolean; course: string } | null,
  /** Show your best run as a ghost. */
  showBest: store("ghost") !== "0",
  /** A dev aid: a CPU pilot rides your bike in place of your hands. */
  autopilot: null as Pilot | null,
};

/** No animation frame for this long (ms): the page isn't animating (a hidden tab or pane). */
const STILL_MS = 250;
/** How long the course goes on drawing under the results, for the camera to settle (ms). */
const SETTLE_MS = 1000;
/** You're "stuck" after this long without getting anywhere. */
const STUCK_MS = 3500;

const LENGTHS: Record<CourseLength, string> = {
  short: "Short — about 30 s",
  medium: "Medium — about 1 min",
  long: "Long — about 1½ min",
};
const DIFFICULTY: Record<Difficulty, string> = {
  easy: "Easy — bumps and small jumps",
  normal: "Normal — jumps and gaps",
  hard: "Hard — big air",
};

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "dust-up",
  title: "Dust Up",
  prefix: "du",
  logo: "DUST<br />UP",
  tagline: "Side-on dirt bike races for friends.<br />No accounts — just share a code.",
  placeholder: "Rider",
  footer: "After <em>Dirt Bike</em> (1995), the classic Mac shareware game.",
  playersLabel: "Riders",
  colors: PLAYER_COLORS,
  minPlayers: 1,
  soloLabel: "Ride solo",
  rules: [
    "Everyone rides the same course at once. Other riders are ghosts: ride right through them.",
    "Gas, brake and lean to wheelie, land jumps and keep your head off the dirt.",
    "Crash and you're back at the last checkpoint. The clock keeps running.",
    "Fastest time wins the course: 10, 8, 6, 5, 4, 3, 2, 1 points. Most points wins the series.",
  ],
  soloRules: [
    "A time trial: ride each course as fast as you can.",
    "Your best run on a course rides beside you as a ghost.",
    "Crash and you're back at the last checkpoint. The clock keeps running.",
    "After each course, ride it again or go on to the next.",
  ],
  settings: {
    courses: { label: "Courses", fmt: (v: number) => String(v) },
    length: { label: "Length", fmt: (v: CourseLength) => LENGTHS[v] ?? v },
    difficulty: { label: "Courses are", fmt: (v: Difficulty) => DIFFICULTY[v] ?? v },
    window: { label: "After the winner", fmt: (v: number) => `${v} s to finish` },
  },
  choices: SETTING_CHOICES,
  onWelcome,
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s): string | null =>
    s.phase !== "lobby" && s.phase !== "gameover" ? "Leave this game? Your bike comes off the course." : null,
  isLive: (s) => isLive(s),
});

const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));
const controls = new Controls($("stage"), onKey);
const engine = new Engine();
const coarse = window.matchMedia("(pointer: coarse)");
const myPose = new Bike();
const bestPose = new Bike();

const serverNow = () => shell.serverNow();
const me = (s = shell.state): PlayerState | undefined => s?.players.find((p) => p.id === shell.me);
const playerById = (id: string | null | undefined) => shell.player(id);

function isLive(s = shell.state): boolean {
  return !!s && (s.phase === "countdown" || s.phase === "riding");
}

/** The race on screen, if it's the state's. */
function currentRace(s = shell.state): ClientRace | null {
  const r = app.race;
  return r && s && r.run === s.run ? r : null;
}

/** The course clock now, in ticks (and fractions of one). */
function clockNow(s: GameState): number {
  return s.startAt === null ? 0 : ((serverNow() - s.startAt) * TICK_HZ) / 1000;
}

/** Whether bikes are moving: riding, or the gate has dropped and the state saying so is on its way. */
function gateDown(s: GameState): boolean {
  return s.phase === "riding" || (s.phase === "countdown" && s.phaseDeadline !== null && serverNow() >= s.phaseDeadline);
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
  if (screen !== "game") {
    controls.enabled = false;
    controls.unlock();
    engine.stop();
  }
}

/** Left the game, or lost it for good. */
function onReset(): void {
  app.race = null;
  app.follow = null;
  $("results").hidden = true;
  $("gameover").hidden = true;
  engine.stop();
}

function onWelcome(msg: ServerMsg): void {
  if (msg.t !== "welcome") return;
  app.welcomed = true;
  setRace(msg.race);
}

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case "race":
      setRace(msg.race);
      break;
    case "frame":
      onFrame(msg);
      break;
    case "sync": {
      const r = app.race;
      if (r?.mine && r.run === msg.run) r.mine.adopt(msg.ride, msg.input);
      break;
    }
  }
}

function setRace(snap: RaceSnapshot | null): void {
  if (!snap) {
    app.race = null;
    return;
  }
  const fresh = app.race?.run !== snap.run;
  app.race = new ClientRace(snap, shell.me, app.race);
  if (fresh) {
    renderer.cam.ready = false;
    app.split = null;
    app.progressAt = performance.now();
    app.progressX = 0;
  }
}

function onFrame(msg: Extract<ServerMsg, { t: "frame" }>): void {
  const race = app.race;
  if (!race || race.run !== msg.run) return;
  const ok = race.frame(msg.k, msg.r, shell.me);
  // Our bike isn't what the room has: ask for the room's (once a second at most).
  if (!ok && performance.now() - app.resyncAt > 1000) {
    app.resyncAt = performance.now();
    shell.send({ t: "resync", run: race.run });
  }
}

/** The shell has shown the lobby or the game screen (and drawn the lobby). */
function onState(s: GameState, prev: GameState | null): void {
  const welcomed = app.welcomed;
  app.welcomed = false;
  if (s.phase === "lobby" || s.phase === "gameover") app.race = null;
  if (prev && !welcomed && s.phase === "results" && prev.phase !== "results") {
    controls.unlock();
    const res = s.results?.find((r) => r.id === shell.me);
    if (res?.place === 1 && res.ticks !== null && !s.solo) sfx.win();
    noteBest(s);
  }
  render();
}

/** After a course: offer your run as your best on the course (it's kept with its ghost if it is). */
function noteBest(s: GameState): void {
  const race = currentRace(s) ?? app.race;
  const mine = race?.mine;
  const ticks = s.finishes[shell.me];
  app.best = null;
  if (!race || !mine || ticks === undefined) return;
  const pb = offerRun(race.course, `${s.code}:${s.run}`, ticks, mine.log);
  app.best = { ...pb, course: race.course.id };
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
  // beneath it, the course keeps its last frame once the camera has settled (unless a resize
  // wiped it).
  const covered = !$("results").hidden;
  app.coveredAt = covered ? app.coveredAt || now : 0;
  if (!covered || now - app.coveredAt < SETTLE_MS || renderer.blank) draw(now);
  hud(now);
}

/** Steps your bike to the clock and sends your inputs. */
function step(now: number): void {
  const s = shell.state;
  const race = currentRace(s);
  const mine = race?.mine ?? null;
  const riding = !!s && !!mine && isLive(s);
  controls.enabled = riding;
  if (!s || !race) {
    engine.stop();
    return;
  }
  if (mine && riding && gateDown(s)) {
    const target = Math.floor(clockNow(s));
    const pilot = app.autopilot;
    const read = pilot
      ? (into: RideInput) => pilot.decide(mine.ride, race.course, into)
      : (into: RideInput) => controls.read(into);
    race.advance(target, read, (e) => myEvent(e, now));
    controls.settle();
    if (now - app.sentAt >= SEND_MS) {
      const msg = mine.message();
      if (shell.send(msg)) mine.sent(msg);
      app.sentAt = now;
    }
  }
  if (race.best && isLive(s) && gateDown(s)) race.best.advance(Math.floor(clockNow(s)));
  // The engine: idling at the gate (revs if you hold the gas), then the rear wheel's speed.
  if (mine && isLive(s)) {
    const b = mine.ride.bike;
    const rpm = s.phase === "countdown" && !gateDown(s) ? (controls.revving ? 0.6 : 0.05) : Math.abs(b.rear.w) / 60;
    const gas = gateDown(s) ? mine.inputAt(mine.ride.tick)[1] & 1 : controls.revving ? 1 : 0;
    engine.set(rpm, gas, !b.crashed && !document.hidden);
  } else engine.stop();
}

function myEvent(e: MyEvent, now: number): void {
  const s = shell.state!;
  const race = currentRace(s)!;
  switch (e.k) {
    case "crash":
      sfx.crash();
      break;
    case "land":
      sfx.land(e.hard);
      break;
    case "checkpoint": {
      sfx.checkpoint();
      const parts: string[] = [];
      const best = race.best?.cpTicks[e.cp];
      if (best !== undefined) parts.push(splitHtml(e.tick - best, "best"));
      const lead = race.leaderAt(e.cp, shell.me, e.tick);
      if (lead && lead.id !== shell.me) parts.push(splitHtml(e.tick - lead.tick, playerById(lead.id)?.name ?? "leader"));
      else if (race.riders.length > 1) parts.push(`<span class="ahead">leading</span>`);
      app.split = { html: `CP ${e.cp} ${parts.join(" · ")}`, until: now + 3000 };
      break;
    }
    case "finish": {
      sfx.finish();
      const place = Object.values(s.finishes).filter((t) => t < e.tick).length + 1;
      app.flash = {
        html: `<span class="big">FINISHED${s.solo || race.riders.length === 1 ? "" : ` ${ordinal(place).toUpperCase()}`}</span>${formatTicks(e.tick)}`,
        until: now + 3000,
        cls: "",
      };
      break;
    }
    case "respawn":
      app.progressAt = now;
      break;
  }
}

function splitHtml(dt: number, who: string): string {
  const sign = dt <= 0 ? "−" : "+";
  return `<span class="${dt <= 0 ? "ahead" : "behind"}">${sign}${(Math.abs(dt) / TICK_HZ).toFixed(2)}</span> ${esc(who)}`;
}

/** Who the camera follows when you're not riding: your pick, or whoever is furthest along and still riding. */
function spectating(race: ClientRace): string | null {
  if (app.follow && race.ghosts.has(app.follow)) return app.follow;
  let best: string | null = null;
  let bestX = -Infinity;
  for (const [id, g] of race.ghosts) {
    const x = g.flags & F_FINISHED ? g.x - 1e6 : g.x;
    if (x > bestX) {
      bestX = x;
      best = id;
    }
  }
  return best;
}

let lastDraw = 0;

function draw(now: number): void {
  const s = shell.state;
  const race = app.race;
  if (!s || !race) return;
  const dt = Math.min(0.1, (now - lastDraw) / 1000);
  lastDraw = now;
  const ft = gateDown(s) ? clockNow(s) : 0;
  const bikes: DrawBike[] = [];
  const t = Math.max(0, ft - DELAY);
  for (const [id, g] of race.ghosts) {
    if (!g.at(t)) continue;
    const p = playerById(id);
    bikes.push({ bike: g.pose, look: lookFor(p?.color ?? "#ffffff", g.flags & F_AWAY ? 0.25 : 0.5), name: p?.name ?? "" });
  }
  if (race.best && app.showBest) {
    poseBetween(bestPose, race.best.prev, race.best.ride, ft);
    bikes.push({ bike: bestPose, look: lookFor("#f4f1e8", 0.35), name: "Your best" });
  }
  let focus: Bike | null = null;
  let passed = 0;
  const mine = race.mine;
  if (mine) {
    poseBetween(myPose, mine.prev, mine.ride, ft);
    bikes.push({ bike: myPose, look: lookFor(me(s)?.color ?? PLAYER_COLORS[0]) });
    passed = mine.ride.checkpoint;
  }
  // Once you've finished and rolled to a stop, watch the others.
  const done = mine && mine.ride.finishTick >= 0 && mine.ride.tick - mine.ride.finishTick > 3 * TICK_HZ;
  if (mine && !done) focus = myPose;
  else {
    const id = spectating(race);
    const g = id ? race.ghosts.get(id) : null;
    if (g) {
      focus = g.pose;
      passed = g.cp;
    } else if (mine) focus = myPose;
  }
  if (focus) renderer.follow(focus, dt, race.course.ground.heightAt(focus.x + Math.max(0, focus.vx) * 0.6));
  renderer.draw(race.course, bikes, passed);
}

// ------------------------------------------------------------------ HUD

function hud(now: number): void {
  const s = shell.state;
  const race = currentRace(s);
  if (!s) return;
  const mine = race?.mine ?? null;
  const tick = s.startAt !== null && gateDown(s) ? Math.max(0, Math.floor(clockNow(s))) : 0;

  // The clock: your time, or the course's.
  const myTicks = mine ? (mine.ride.finishTick >= 0 ? mine.ride.finishTick : mine.ride.tick) : tick;
  setText($("hud-clock"), formatTicks(isLive(s) || s.phase === "results" ? myTicks : 0));
  setHtml($("hud-course"), s.course ? `Course <b>${s.course}/${s.settings.courses}</b>` : "");
  const placing = race && mine && race.riders.length > 1 && gateDown(s);
  setHtml($("hud-place"), placing ? `<b>${ordinal(livePlace(s, race))}</b> of ${race.riders.length}` : "");
  setText($("hud-speed"), mine ? `${Math.round(Math.hypot(mine.ride.bike.vx, mine.ride.bike.vy) * 3.6)} km/h` : "");

  // The course ends soon after the winner: say so.
  const end = $("hud-end");
  const firstDone = Object.keys(s.finishes).length > 0;
  if (s.phase === "riding" && firstDone && s.endTick !== null) {
    end.hidden = false;
    setText(end, `Ends in ${Math.max(0, Math.ceil((s.endTick - tick) / TICK_HZ))} s`);
  } else if (s.phase === "riding" && s.endTick !== null && s.endTick - tick < 20 * TICK_HZ) {
    end.hidden = false;
    setText(end, `Time's up in ${Math.max(0, Math.ceil((s.endTick - tick) / TICK_HZ))} s`);
  } else end.hidden = true;

  const split = $("hud-split");
  if (app.split && now < app.split.until && isLive(s)) {
    split.hidden = false;
    setHtml(split, app.split.html);
  } else split.hidden = true;

  // The strip: everyone along the course.
  renderStrip(s, race);
  renderBanner(s, race, now);
  renderPad(s, race);

  // The lean meter, while the mouse steers.
  const meter = $("lean-meter");
  meter.hidden = !controls.locked || !mine;
  if (!meter.hidden) (meter.firstElementChild as HTMLElement).style.left = `${50 + controls.mouseLean * 50}%`;
}

function livePlace(s: GameState, race: ClientRace): number {
  const mine = race.mine!;
  const myFinish = mine.ride.finishTick;
  let place = 1;
  for (const [id, g] of race.ghosts) {
    const theirs = s.finishes[id];
    if (myFinish >= 0) {
      if (theirs !== undefined && theirs < myFinish) place++;
    } else if (theirs !== undefined || g.x > mine.ride.bike.x) place++;
  }
  return place;
}

function renderStrip(s: GameState, race: ClientRace | null): void {
  const strip = $("strip");
  if (!race || !isLive(s)) {
    setHtml(strip, "");
    return;
  }
  const course = race.course;
  const pct = (x: number) => `${(progressOf(course, x) * 100).toFixed(2)}%`;
  const key = `${race.run}:${race.riders.join(",")}`;
  if (strip.dataset.key !== key) {
    strip.dataset.key = key;
    const marks = course.checkpoints.slice(1).map((x) => `<i class="cp" style="left:${pct(x)}"></i>`);
    const dots = race.riders.map((id) => {
      const p = playerById(id);
      return `<i data-id="${id}" class="${id === shell.me ? "you" : ""}" style="background:${p?.color ?? "#fff"}"></i>`;
    });
    strip.innerHTML = `<div class="strip-line"></div>${marks.join("")}<i class="flag" style="left:100%"></i>${
      race.best && app.showBest ? `<i class="best" data-id="__best"></i>` : ""
    }${dots.join("")}`;
    delete strip.dataset.html;
  }
  for (const dot of $$<HTMLElement>("#strip i[data-id]")) {
    const id = dot.dataset.id!;
    const x =
      id === shell.me
        ? (race.mine?.ride.bike.x ?? 0)
        : id === "__best"
          ? (race.best?.ride.bike.x ?? 0)
          : (race.ghosts.get(id)?.pose.x ?? 0);
    dot.style.left = pct(x);
  }
}

function renderBanner(s: GameState, race: ClientRace | null, now: number): void {
  const el = $("banner");
  const show = (html: string, cls = "") => {
    setHtml(el, html);
    el.className = `banner ${cls}`;
    el.hidden = false;
  };
  const mine = race?.mine ?? null;
  if (s.phase === "countdown" && !gateDown(s)) {
    const secs = Math.max(1, Math.ceil(((s.phaseDeadline ?? 0) - serverNow()) / 1000));
    if (secs !== app.lastCount) {
      app.lastCount = secs;
      sfx.count();
    }
    const resuming = (race?.mine?.ride.tick ?? 0) > 0 || (race && race.frameTick > 0);
    const hint = !mine
      ? "You'll ride from the next course"
      : resuming
        ? "Going on from where you were"
        : coarse.matches
          ? "Hold GAS to rev"
          : "Hold ↑ to rev · click the course to ride with the mouse";
    show(`<span class="count">${secs}</span>${hint}`);
    return;
  }
  if (app.lastCount) {
    app.lastCount = 0;
    if (s.phase === "countdown" || s.phase === "riding") {
      sfx.go();
      app.flash = { html: `<span class="count">GO!</span>`, until: now + 700, cls: "" };
    }
  }
  if (!isLive(s)) {
    el.hidden = true;
    return;
  }
  if (mine) {
    const ride = mine.ride;
    const input = mine.inputAt(ride.tick);
    if (input[1] & 4) return show(`<span class="big">HELD</span>Let go of R to ride from the checkpoint`);
    if (ride.bike.crashed) {
      const left = Math.max(0, (RESPAWN_TICKS - ride.crashTicks) / TICK_HZ);
      return show(`<span class="big">CRASHED!</span>Back at the checkpoint in ${left.toFixed(1)} s`);
    }
  }
  if (app.flash && now < app.flash.until) return show(app.flash.html, app.flash.cls);
  if (mine && mine.ride.finishTick < 0 && gateDown(s)) {
    // Stuck: on the gas, and getting nowhere for a while.
    const gas = mine.inputAt(mine.ride.tick)[1] & 1;
    if (!gas || mine.ride.bike.x > app.progressX + 1) {
      app.progressX = mine.ride.bike.x;
      app.progressAt = now;
    } else if (now - app.progressAt > STUCK_MS) {
      return show(`<span class="big">STUCK?</span>${coarse.matches ? "Tap ↺" : "Press R"} to go back to the checkpoint`);
    }
  }
  if (!mine && race) {
    const id = spectating(race);
    const p = playerById(id);
    const you = me(s);
    const why = you && !you.spectator ? "You'll ride from the next course." : "You're watching.";
    if (p) return show(`Watching <b style="color:${p.color}">${esc(p.name)}</b><small>${why}</small>`, "watching");
  }
  el.hidden = true;
}

function renderPad(s: GameState, race: ClientRace | null): void {
  const pad = $("pad");
  const mine = race?.mine;
  pad.hidden = !coarse.matches || !mine || !isLive(s) || (mine.ride.finishTick >= 0 && s.phase === "riding");
}

// ------------------------------------------------------------------ rendering: panels

function render(): void {
  const s = shell.state;
  if (!s || shell.screen !== "game") return;
  renderPlayers(s);
  renderResults(s);
  renderGameOver(s);
  const ghost = $("ghost-toggle");
  ghost.setAttribute("aria-pressed", String(app.showBest));
}

function renderPlayers(s: GameState): void {
  const race = currentRace(s);
  const alone = s.players.filter((p) => !p.spectator).length === 1;
  const rows = s.players
    .filter((p) => !p.spectator)
    .sort(rankPlayers)
    .map((p) => {
      let status = "";
      let riding = false;
      const finish = s.finishes[p.id];
      const g = race?.ghosts.get(p.id);
      if (isLive(s) && race) {
        if (!race.riders.includes(p.id)) status = "Next course";
        else if (finish !== undefined) status = `Finished · ${formatTicks(finish)}`;
        else if (g && g.flags & F_CRASHED) status = "Crashed";
        else if (g && g.flags & F_AWAY) status = "Away";
        else if (p.id === shell.me && race.mine) {
          status = `Riding · CP ${race.mine.ride.checkpoint}`;
          riding = true;
        } else {
          status = g ? `Riding · CP ${g.cp}` : "Riding";
          riding = true;
        }
      } else if (s.phase === "results") {
        const r = s.results?.find((x) => x.id === p.id);
        if (r) status = r.ticks !== null ? `${ordinal(r.place)} · ${formatTicks(r.ticks)}` : "DNF";
      }
      const cls = [
        p.id === shell.me ? "you" : "",
        app.follow === p.id ? "following" : "",
        !p.cpu && !p.connected ? "offline" : "",
      ].join(" ");
      const tag = p.id === shell.me ? ` <span class="tag tag-you">you</span>` : p.cpu ? ` <span class="tag">CPU</span>` : "";
      // On your own, points and wins mean nothing.
      const wins = alone || !p.wins ? "" : ` · ${p.wins} win${p.wins > 1 ? "s" : ""}`;
      return `<li class="${cls}" data-follow="${p.id}" title="Follow ${esc(p.name)}">
        <span class="chip" style="background:${p.color}"></span>
        <span class="pname">${esc(p.name)}${tag}</span>
        <span class="pts" title="Points">${alone ? "" : p.points}</span>
        <span class="status ${riding ? "riding" : ""}">${status}${wins}</span>
      </li>`;
    });
  const spectators = s.players.filter((p) => p.spectator);
  if (spectators.length) {
    rows.push(`<li class="muted" style="display:block">Watching: ${spectators.map((p) => esc(p.name)).join(", ")}</li>`);
  }
  setHtml($("game-players"), rows.join(""));
}

function renderResults(s: GameState): void {
  const open = s.phase === "results" && !!s.results;
  $("results").hidden = !open;
  if (!open) return;
  const res = s.results!;
  const winner = res[0];
  const solo = s.solo;
  $("results").classList.toggle("solo", solo);
  setText($("results-title"), `Course ${s.course} of ${s.settings.courses}`);
  const fastest = winner?.ticks ?? null;
  const mine = res.find((r) => r.id === shell.me);
  let line = "";
  if (solo) {
    const b = app.best;
    if (mine?.ticks == null) line = "You didn't make it to the finish.";
    else if (b && b.fresh && b.prev !== null && b.best < b.prev)
      line = `<span class="best">New best!</span> ${formatTicks(b.best)}, ${((b.prev - b.best) / TICK_HZ).toFixed(2)} s quicker than before.`;
    else if (b && b.prev === null) line = `Your first time on this course: ${formatTicks(mine.ticks)}.`;
    else if (b) line = `Your best here is ${formatTicks(b.best)}.`;
  } else if (winner && fastest !== null) {
    const p = playerById(winner.id);
    line = `<b style="color:${p?.color ?? "inherit"}">${esc(p?.name ?? "?")}</b> takes it in ${formatTicks(fastest)}.`;
    if (app.best?.fresh && app.best.prev !== null && app.best.best < app.best.prev)
      line += ` <span class="best">You set a new best!</span>`;
  } else line = "Nobody made it to the finish.";
  setHtml($("results-line"), line);
  setHtml(
    $("results-rows"),
    res
      .map((r) => {
        const p = playerById(r.id);
        const time = r.ticks !== null ? formatTicks(r.ticks) : `DNF · ${Math.round(r.progress * 100)}%`;
        const gap =
          r.ticks !== null && fastest !== null && r.ticks > fastest ? `+${((r.ticks - fastest) / TICK_HZ).toFixed(2)}` : "";
        return `<tr class="${r.place === 1 && r.ticks !== null ? "winner" : ""}">
          <td>${r.ticks !== null ? r.place : "—"}</td>
          <td><span class="pcell"><span class="chip" style="background:${p?.color ?? "#888"}"></span>${esc(p?.name ?? "Gone")}</span></td>
          <td class="${r.ticks === null ? "dnf" : ""}">${time}</td><td>${gap}</td><td>${r.points ? `+${r.points}` : ""}</td><td>${p?.points ?? ""}</td></tr>`;
      })
      .join(""),
  );
  const last = s.course >= s.settings.courses;
  $("results-solo").hidden = !solo;
  setText($("results-on"), last ? "Finish" : "Next course");
  const next = $("results-next");
  if (solo) setText(next, shell.canHost(s) ? "" : "Waiting for the rider…");
  else setHtml(next, `${last ? "Final standings" : "Next course"} in <span data-countdown></span> s`);
  tickResults(s);
}

function tickResults(s = shell.state): void {
  if (!s || s.phase !== "results" || s.solo) return;
  const secs = s.phaseDeadline ? Math.max(0, Math.ceil((s.phaseDeadline - serverNow()) / 1000)) : 0;
  for (const el of $$("[data-countdown]")) setText(el, String(secs));
}

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover";
  $("gameover").hidden = !open;
  if (!open) return;
  const ranked = s.players.filter((p) => !p.spectator).sort(rankPlayers);
  const best = ranked[0];
  setHtml(
    $("gameover-winner"),
    ranked.length === 1
      ? `You rode ${s.settings.courses} course${s.settings.courses > 1 ? "s" : ""}.`
      : best
        ? `<b style="color:${best.color}">${esc(best.name)}</b> rules the dirt.`
        : "",
  );
  setHtml(
    $("gameover-rows"),
    ranked
      .map(
        (p, i) => `<tr class="${i === 0 ? "winner" : ""}">
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${p.color}"></span>${esc(p.name)}</span></td>
        <td>${p.points}</td><td>${p.wins}</td></tr>`,
      )
      .join(""),
  );
  const back = $<HTMLButtonElement>("gameover-lobby");
  const host = shell.canHost(s);
  back.disabled = !host;
  back.textContent = host ? "Back to lobby" : `Waiting for ${playerById(s.hostId)?.name ?? "host"}…`;
}

// ------------------------------------------------------------------ keys and buttons

function onKey(code: string): void {
  if (shell.screen !== "game") return;
  unlockAudio();
  if (code === "KeyG") toggleGhost();
}

function toggleGhost(): void {
  app.showBest = !app.showBest;
  store("ghost", app.showBest ? "1" : "0");
  $("strip").dataset.key = "";
  render();
}

function wire(): void {
  controls.wireTouch($$("[data-ctl]"));
  $("pad").addEventListener("pointerdown", () => unlockAudio());
  $("ghost-toggle").addEventListener("click", (e) => {
    toggleGhost();
    (e.currentTarget as HTMLElement).blur();
  });
  $("results-again").addEventListener("click", (e) => {
    shell.send({ t: "again" });
    (e.currentTarget as HTMLElement).blur();
  });
  $("results-on").addEventListener("click", (e) => {
    shell.send({ t: "next" });
    (e.currentTarget as HTMLElement).blur();
  });
  $("game-players").addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-follow]")?.dataset.follow;
    if (!id) return;
    app.follow = app.follow === id || id === shell.me ? null : id;
    render();
  });
  // Buttons on the game screen give the keys back to the game once clicked.
  $("screen-game").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b && !b.closest("form")) b.blur();
  });
}

wire();
shell.start();
requestAnimationFrame(frame);

// A hidden tab or pane doesn't run animation frames: keep the bike on the clock (and inputs
// going) from a timer, and redraw the panels now and then.
setInterval(() => {
  const now = performance.now();
  if (shell.screen === "game" && now - app.lastNow > STILL_MS) {
    step(now);
    hud(now);
  }
  tickResults();
}, 50);
setInterval(() => {
  if (shell.screen === "game" && isLive()) renderPlayers(shell.state!);
}, 500);

if (import.meta.env.DEV) {
  Object.assign(window, {
    __du: {
      app,
      shell,
      renderer,
      controls,
      /** Rides your bike with a CPU pilot ("easy", "normal", "hard"), or your hands again with null. */
      autopilot(level: CpuLevel | null) {
        app.autopilot = level ? new Pilot(level, 1) : null;
      },
    },
  });
}
