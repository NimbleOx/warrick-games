import { $, esc, personalBest } from "@warrick/kit/client/dom";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import type { BottleEvent } from "../shared/bottle";
import { COLS, MAX_LEVEL, PLAYER_COLORS, TICKS_PER_SEC, TICK_MS, virusCount } from "../shared/constants";
import {
  SETTING_CHOICES,
  type Aim,
  type Attack,
  type ClientMsg,
  type GameState,
  type PlayerState,
  type RoundSnap,
  type ServerMsg,
  type Speed,
} from "../shared/protocol";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { Controls } from "./input";
import { BottleCanvas, bottleSize } from "./render";
import { RoundView } from "./view";

// ------------------------------------------------------------------ helpers

function pips(wins: number, target: number): string {
  const n = Math.max(target, wins);
  return Array.from({ length: n }, (_, i) => `<i class="${i < wins ? "on" : ""}"></i>`).join("");
}

const SPEED_NAMES: Record<Speed, string> = { low: "Low", med: "Med", hi: "Hi" };
const AIM_NAMES: Record<Aim, string> = {
  leader: "Whoever's winning",
  random: "A random rival",
  all: "Everyone",
};
const PALETTE = ["#fff", "#ff4d6d", "#ffd23f", "#4da6ff"];
const fmt = (n: number) => n.toLocaleString("en");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// ------------------------------------------------------------------ app state

interface RivalCard {
  slot: number;
  el: HTMLElement;
  canvas: BottleCanvas;
}

const app = {
  /** This browser's copy of the round. */
  view: null as RoundView | null,
  viewKey: "",
  /** Names and colors of everyone seen, so a player who left still has a label. */
  people: new Map<string, { name: string; color: string }>(),
  rivals: new Map<number, RivalCard>(),
  rivalKey: "",
  layoutKey: "",
  ownCell: 0,
  lastFrame: 0,
  bannerKey: "",
  sounded: "",
  overSounded: "",
};

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "pill-panic",
  title: "Pill Panic",
  prefix: "pp",
  logo: `<span class="r">PILL</span><br /><span class="b">PAN</span><span class="y">IC</span>`,
  tagline: "Clear your bottle of germs before your friends do.<br />No accounts — just share a code.",
  placeholder: "Doc",
  footer: "Line up four of a color to wipe out a germ. Chain clears to bury your rivals.",
  rules: [
    "Line up four of one color, across or down, to clear them. Germs included.",
    "Clear every germ in your bottle to win the round. Fill the bottle to the top and you're out.",
    "Clear two or more lines with one capsule, at once or in a chain, to drop junk on a rival.",
    "Everyone gets the same germs and the same capsules.",
  ],
  minPlayers: 1,
  soloRules: [
    "On your own, clear the bottle to go up a level: four more germs each time. Top out and the run is over.",
    "Each germ scores 100, 200 or 300 by speed, and twice as much as the last one in the same combo.",
    "Your best score is kept in this browser. Add a CPU or invite a friend for a match instead.",
  ],
  colors: PLAYER_COLORS,
  settings: {
    level: { label: "Germ level", fmt: (v: number) => `${v} · ${virusCount(v)} germs` },
    speed: { label: "Speed", fmt: (v: Speed) => ({ low: "Low", med: "Medium", hi: "High" })[v] },
    wins: { label: "Match", fmt: (v: number) => `First to ${v} round${v === 1 ? "" : "s"}` },
    aim: { label: "Junk hits", fmt: (v: Aim) => AIM_NAMES[v] },
  },
  choices: SETTING_CHOICES,
  playerTags: (p) => (p.trophies ? `<span class="tag">${p.trophies} match${p.trophies > 1 ? "es" : ""} won</span>` : ""),
  onWelcome: (msg) => msg.t === "welcome" && onWelcome(msg.snap),
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s) =>
    s.phase === "playing" && (me()?.slot ?? -1) >= 0 && !s.round?.over ? "Leave this game? Your bottle tops out." : null,
  isLive: (s) => s.phase === "playing",
});
const ownCanvas = new BottleCanvas($<HTMLCanvasElement>("game-canvas"), true);
const attract = new Attract($<HTMLCanvasElement>("attract"));

const me = (): PlayerState | undefined => shell.mine;
const playerById = (id: string | null | undefined) => shell.player(id);
const canHost = (s = shell.state) => shell.canHost(s);
/** Every bottle runs on the server's clock (the shell's, from the quickest recent ping). */
const serverNow = () => shell.serverNow();
const wallTick = () => app.view?.wall(serverNow()) ?? -1;
const colorOf = (slot: number) => app.people.get(app.view?.who[slot] ?? "")?.color ?? "#8d94b8";
/** A solo run: one player, level after level. */
const solo = (s = shell.state) => !!s?.solo;

const controls = new Controls(() => {
  const v = app.view;
  const own = v?.own;
  return shell.screen === "game" && !!own && !v.over && !own.b.done && wallTick() >= 0;
});
controls.bindPad($("pad"));

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "game") layout();
  if (screen === "home") attract.resize();
}

/** Left the game, or lost it for good. */
function onReset(): void {
  app.view = null;
  app.viewKey = "";
  controls.reset();
  $("results").hidden = true;
}

function onWelcome(snap: RoundSnap | null): void {
  setView(snap);
}

// ------------------------------------------------------------------ messages

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case "snap":
      setView(msg.snap);
      break;
    case "f":
      if (!app.view) return;
      app.view.frame(msg);
      // Keep our bottle going (and reporting) even when the tab is in the background.
      app.view.stepOwn(wallTick(), () => controls.sample());
      break;
  }
}

function setView(snap: RoundSnap | null): void {
  if (!snap) return;
  const key = `${snap.round}:${snap.lanes[0]?.b.seed ?? 0}`;
  if (app.view && app.viewKey === key) {
    app.view.applySnap(snap);
  } else {
    app.view = new RoundView(snap, shell.me, {
      send: (m) => shell.send(m),
      events: onBottleEvents,
      attack: onAttack,
    });
    app.viewKey = key;
    app.bannerKey = "";
    controls.reset();
  }
  app.view.syncState(shell.state?.round);
  layout();
}

function onState(s: GameState, prev: GameState | null): void {
  for (const p of s.players) app.people.set(p.id, { name: p.name, color: p.color });
  if (s.phase === "lobby") {
    app.view = null;
    app.viewKey = "";
  }
  app.view?.syncState(s.round);
  const over = s.round?.over;
  if (over && s.round) {
    const key = `${s.match}:${s.round.n}`;
    if (app.overSounded !== key && prev) {
      app.overSounded = key;
      if (over.winners.includes(shell.me)) sfx.win();
      else if (app.view?.mine !== undefined && app.view.mine >= 0) sfx.lose();
    }
  }
  if (s.phase !== "lobby") renderGame(s);
}

// ------------------------------------------------------------------ effects

function onBottleEvents(slot: number, events: BottleEvent[]): void {
  const mine = slot === app.view?.mine;
  for (const e of events) {
    if (!mine) {
      if (e.k === "pop" && e.chain >= 2) popup(rivalEl(slot), `${e.chain} CHAIN`);
      continue;
    }
    switch (e.k) {
      case "move":
        sfx.move();
        break;
      case "rotate":
        sfx.rotate();
        break;
      case "land":
        sfx.land();
        break;
      case "pop":
        sfx.pop(e.chain, e.viruses);
        if (e.chain >= 2) popup($("stage"), `${e.chain} CHAIN!`);
        break;
      case "attack":
        popup($("stage"), `ATTACK ×${e.colors.length}`);
        break;
      case "garbage":
        sfx.garbage();
        break;
      case "won":
        sfx.clear();
        break;
      case "dead":
        sfx.out();
        break;
    }
  }
}

function onAttack(a: Attack): void {
  const mine = app.view?.mine ?? -1;
  if (a.from === mine) sfx.attack();
  if (a.to === mine) sfx.warn();
  const from = a.from === mine ? $("stage") : rivalEl(a.from);
  const to = a.to === mine ? $("stage") : rivalEl(a.to);
  if (!from || !to || shell.screen !== "game") return;
  const r1 = from.getBoundingClientRect();
  const r2 = to.getBoundingClientRect();
  a.p.forEach(([, c], i) => {
    const dot = document.createElement("div");
    dot.className = "flyer";
    dot.style.color = PALETTE[c];
    dot.style.left = `${r1.left + r1.width / 2}px`;
    dot.style.top = `${r1.top + r1.height * 0.4}px`;
    document.body.append(dot);
    const dx = r2.left + r2.width / 2 - (r1.left + r1.width / 2) + (i - a.p.length / 2) * 12;
    const dy = r2.top + r2.height * 0.15 - (r1.top + r1.height * 0.4);
    const anim = dot.animate(
      [
        { transform: "translate(0, 0) scale(1)" },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 60}px) scale(1.3)`, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.7)` },
      ],
      { duration: 550 + i * 60, easing: "ease-in-out" },
    );
    anim.onfinish = () => {
      dot.remove();
      if (i === 0 && to !== $("stage")) {
        to.classList.remove("hit");
        void to.offsetWidth;
        to.classList.add("hit");
      }
    };
  });
}

function popup(host: HTMLElement | null, text: string): void {
  if (!host) return;
  const el = document.createElement("div");
  el.className = "chain-pop";
  el.textContent = text;
  el.style.top = `${host.clientHeight * 0.3}px`;
  host.append(el);
  el.addEventListener("animationend", () => el.remove());
}

function rivalEl(slot: number): HTMLElement | null {
  return app.rivals.get(slot)?.el ?? null;
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = app.lastFrame ? now - app.lastFrame : 16;
  app.lastFrame = now;
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  const v = app.view;
  if (shell.screen !== "game" || !v) return;
  v.stepOwn(wallTick(), () => controls.sample());
  v.advanceMirrors(Math.min(30, dt / TICK_MS));
  if (v.own) {
    ownCanvas.draw(v.own.b, {
      time: now,
      ghost: true,
      next: true,
      incoming: v.incoming(v.mine),
      accent: colorOf(v.mine),
      dim: v.own.b.phase === "dead",
    });
  }
  for (const card of app.rivals.values()) {
    const b = v.bottle(card.slot);
    if (!b) continue;
    card.canvas.draw(b, {
      time: now,
      ghost: false,
      next: false,
      incoming: v.incoming(card.slot),
      accent: colorOf(card.slot),
      dim: b.phase === "dead",
    });
  }
  renderBanner();
  renderLive();
}

// ------------------------------------------------------------------ game

function renderGame(s: GameState): void {
  const r = s.round;
  $("round-label").textContent = !r
    ? ""
    : solo(s)
      ? `Solo run · level ${r.level}`
      : `Match ${s.match} · Round ${r.n} · first to ${s.settings.wins}`;
  $("match-label").textContent = solo(s) ? "Solo run" : `First to ${s.settings.wins}`;
  const mine = me();
  $("own-chip").style.background = mine?.color ?? "#888";
  $("own-name").textContent = mine?.name ?? "";
  $("own-pips").innerHTML = !mine
    ? ""
    : solo(s)
      ? `<span class="muted">${plural(mine.wins, "level")} cleared</span>`
      : pips(mine.wins, s.settings.wins);
  $("own-stats").classList.toggle("solo", solo(s));
  $("hud-level").textContent = r ? String(r.level) : "—";
  $("hud-speed").textContent = r ? SPEED_NAMES[r.speed] : "—";
  syncRivals();
  renderResults(s);
}

/** Cards for everyone else's bottle; rebuilt when who's playing changes. */
function syncRivals(): void {
  const v = app.view;
  const slots = v ? v.slots().filter((s) => s !== v.mine) : [];
  const key = `${app.viewKey}|${slots.join(",")}`;
  const watching = !v?.own;
  document.querySelector(".game-layout")!.classList.toggle("watching", watching);
  if (key !== app.rivalKey) {
    app.rivalKey = key;
    const box = $("rivals");
    box.innerHTML = "";
    app.rivals.clear();
    for (const slot of slots) {
      const el = document.createElement("div");
      el.className = "rival";
      el.innerHTML = `<div class="rival-head"><span class="chip"></span><span class="pname"></span><span class="pips"></span></div>
        <canvas></canvas><div class="rival-foot"><span>Germs <b class="germs"></b></span><span class="junk"></span></div>
        <div class="status"></div>`;
      box.append(el);
      app.rivals.set(slot, { slot, el, canvas: new BottleCanvas(el.querySelector("canvas")!, false) });
    }
  }
  const s = shell.state;
  for (const card of app.rivals.values()) {
    const id = v?.who[card.slot];
    const p = s?.players.find((x) => x.id === id);
    const look = app.people.get(id ?? "");
    card.el.querySelector<HTMLElement>(".chip")!.style.background = look?.color ?? "#888";
    card.el.querySelector(".pname")!.textContent = look?.name ?? "Someone";
    card.el.querySelector(".pips")!.innerHTML = p && s ? pips(p.wins, s.settings.wins) : "";
  }
  const note = $("watch-note");
  const mine = me();
  note.hidden = !watching || !s || s.phase !== "playing";
  note.textContent = mine?.spectator
    ? `All ${MAX_PLAYERS} seats are taken, so you're watching. You'll get a seat when one frees up between rounds.`
    : "You're watching this round. You'll play from the next one.";
  const shape = `${key}|${watching}|${note.hidden}`;
  if (shape !== app.layoutKey) {
    app.layoutKey = shape;
    layout();
  }
}

/** The parts that change every frame: germ counts, statuses. Cheap DOM writes only when they change. */
let liveKey = "";
function renderLive(): void {
  const v = app.view;
  const s = shell.state;
  if (!v || !s) return;
  const own = v.own?.b;
  const germs = own ? String(own.viruses) : "—";
  // Solo: the run's points so far, and this bottle's.
  const score = own && solo(s) ? fmt((me()?.score ?? 0) + (s.round?.over ? 0 : own.score)) : "—";
  let key = `${germs}|${score}`;
  for (const card of app.rivals.values()) {
    const b = v.bottle(card.slot);
    if (!b) continue;
    const id = v.who[card.slot];
    const gone = !!id && !s.players.some((p) => p.id === id);
    const status = b.phase === "won" ? "CLEAR!" : b.phase === "dead" ? (gone ? "LEFT" : "OUT") : "";
    const junk = v.incoming(card.slot).reduce((n, g) => n + g.p.length, 0);
    key += `|${card.slot}:${b.viruses}:${status}:${junk}`;
  }
  const over = s.round?.over;
  key += `|${over ? over.winners.join() : ""}`;
  if (key === liveKey) return;
  liveKey = key;
  $("hud-germs").textContent = germs;
  $("hud-score").textContent = score;
  for (const card of app.rivals.values()) {
    const b = v.bottle(card.slot);
    if (!b) continue;
    const id = v.who[card.slot];
    const gone = !!id && !s.players.some((p) => p.id === id);
    card.el.querySelector(".germs")!.textContent = String(b.viruses);
    const junk = v.incoming(card.slot).reduce((n, g) => n + g.p.length, 0);
    card.el.querySelector(".junk")!.textContent = junk ? `+${junk} junk` : "";
    const winner = !!over && !!id && over.winners.includes(id);
    const status = winner ? "WINS!" : b.phase === "won" ? "CLEAR!" : b.phase === "dead" ? (gone ? "LEFT" : "OUT") : "";
    card.el.querySelector(".status")!.textContent = status;
    card.el.classList.toggle("out", b.phase === "dead");
  }
  renderScoreboard();
}

function renderScoreboard(): void {
  const s = shell.state;
  const v = app.view;
  if (!s) return;
  const rows = s.players
    .filter((p) => !p.spectator)
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name))
    .map((p) => {
      const b = v && p.slot >= 0 && v.who[p.slot] === p.id ? v.bottle(p.slot) : null;
      const status = !b
        ? s.phase === "playing"
          ? !p.cpu && !p.connected
            ? "offline"
            : "sitting this round out"
          : ""
        : b.phase === "won"
          ? "cleared the bottle"
          : b.phase === "dead"
            ? "topped out"
            : `${b.viruses} germ${b.viruses === 1 ? "" : "s"} left`;
      const extra = solo(s) ? ` · ${plural(p.wins, "level")} cleared` : p.sent ? ` · ${p.sent} junk sent` : "";
      return `<li class="${p.id === shell.me ? "me" : ""} ${b?.phase === "dead" ? "out" : ""}">
        <span class="chip" style="background:${p.color}"></span>
        <span class="pname">${esc(p.name)}${p.id === shell.me ? ` <span class="tag tag-you">you</span>` : ""}</span>
        <span class="pips">${solo(s) ? "" : pips(p.wins, s.settings.wins)}</span>
        <span class="meta">${status}${extra}</span>
      </li>`;
    })
    .join("");
  const el = $("scoreboard");
  if (el.innerHTML !== rows) el.innerHTML = rows;
}

/** The big message over your bottle: countdown, GO, cleared, topped out, who took the round. */
function renderBanner(): void {
  const v = app.view;
  const s = shell.state;
  let big = "";
  let sub = "";
  let sound = "";
  const r = s?.round;
  if (v && s && r && s.phase === "playing") {
    const wall = wallTick();
    const own = v.own?.b;
    if (r.over && solo(s)) {
      // Solo, a round only ends early by clearing the bottle: topping out ends the run.
      const next = Math.min(MAX_LEVEL, r.level + 1);
      const secs = r.nextAt ? Math.max(0, Math.ceil((r.nextAt - serverNow()) / 1000)) : 0;
      big = `LEVEL ${r.level} CLEAR!`;
      sub = r.nextAt ? `Level ${next} · ${virusCount(next)} germs in ${secs}…` : "";
    } else if (r.over) {
      const winners = r.over.winners;
      if (!winners.length) big = "DRAW!";
      else if (winners.includes(shell.me)) big = "YOU WIN!";
      else big = `${(app.people.get(winners[0])?.name ?? "?").toUpperCase()} WINS`;
      const how =
        r.over.how === "cleared" ? "cleared the bottle first" : r.over.how === "survived" ? "was the last one standing" : "";
      const who = winners.includes(shell.me) ? "You" : winners.map((id) => esc(app.people.get(id)?.name ?? "?")).join(" & ");
      const next = r.nextAt ? Math.max(0, Math.ceil((r.nextAt - serverNow()) / 1000)) : 0;
      sub = `${how ? `${who} ${how}. ` : ""}${r.nextAt ? `Next round in ${next}…` : ""}`;
    } else if (wall < 0) {
      const n = Math.ceil(-wall / TICKS_PER_SEC);
      big = String(n);
      sub = own ? `Level ${r.level} · ${virusCount(r.level)} germs${solo(s) ? "" : " · clear them all first"}` : "";
      sound = `count${r.n}:${n}`;
    } else if (wall < TICKS_PER_SEC * 0.8 && own) {
      big = "GO!";
      sound = `go${r.n}`;
    } else if (own?.phase === "won") {
      big = "CLEAR!";
      sub = solo(s) ? "" : "Checking nobody beat you to it…";
    } else if (own?.phase === "dead") {
      big = "TOPPED OUT";
      sub = solo(s) ? "" : "You're out of this round. Watch the others.";
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
  el.innerHTML = big ? `<div class="big">${esc(big)}</div>${sub ? `<div class="sub">${sub}</div>` : ""}` : "";
}

/** The solo player's score against their best in this browser; null for a match, or someone else's run. */
function soloBest(s: GameState): { best: number; prev: number | null; fresh: boolean } | null {
  const r = s.results;
  const x = r?.solo ? r.standings[0] : null;
  if (!r || !x || x.id !== shell.me) return null;
  return personalBest(`best.${s.settings.speed}`, `${s.code}:${r.match}`, x.score ?? 0);
}

function renderResults(s: GameState): void {
  const r = s.results;
  const open = s.phase === "results" && !!r;
  $("results").hidden = !open;
  if (!open || !r) return;
  const name = (x: { id: string; name: string; color: string }) =>
    `<span class="pcell"><span class="chip" style="background:${x.color}"></span>${esc(x.name)}${x.id === shell.me ? ` <span class="tag tag-you">you</span>` : ""}</span>`;
  if (r.solo) {
    $("results-title").textContent = "Run over";
    const x = r.standings[0];
    const best = soloBest(s);
    if (best?.fresh && best.prev !== null && app.overSounded !== `best:${r.match}`) {
      app.overSounded = `best:${r.match}`;
      sfx.win();
    }
    const who = x?.id === shell.me ? "You" : `<b style="color:${x?.color}">${esc(x?.name ?? "")}</b>`;
    $("results-winner").innerHTML = !x
      ? esc(r.note || "The run is over.")
      : `${who} cleared ${plural(x.wins, "level")} and topped out on level ${r.level ?? "?"}, with <b>${fmt(x.score ?? 0)}</b> points.` +
        (!best
          ? ""
          : best.fresh && best.prev !== null
            ? ` <b class="best">A new personal best!</b>`
            : best.fresh
              ? " That's your best so far."
              : ` Your best is ${fmt(best.best)}.`);
    $("results-head").innerHTML = `<th></th><th>Player</th><th>Score</th><th>Levels</th><th>Germs</th>`;
    $("results-rows").innerHTML = r.standings
      .map((x) => `<tr><td></td><td>${name(x)}</td><td>${fmt(x.score ?? 0)}</td><td>${x.wins}</td><td>${x.cleared}</td></tr>`)
      .join("");
  } else {
    $("results-title").textContent = `Match ${r.match} results`;
    const winner = r.standings.find((x) => x.id === r.winnerId);
    $("results-winner").innerHTML = winner
      ? `<b style="color:${winner.color}">${esc(winner.id === shell.me ? "You" : winner.name)}</b> ${winner.id === shell.me ? "win" : "wins"} the match, ${winner.wins} round${winner.wins === 1 ? "" : "s"} to ${Math.max(0, ...r.standings.filter((x) => x !== winner).map((x) => x.wins))}.`
      : esc(r.note || "No winner this time.");
    $("results-head").innerHTML = `<th></th><th>Player</th><th>Rounds</th><th>Germs</th><th>Junk sent</th><th>Matches</th>`;
    $("results-rows").innerHTML = r.standings
      .map((x, i) => {
        const p = playerById(x.id);
        return `<tr class="${x.id === r.winnerId ? "winner" : ""}">
        <td>${i + 1}</td>
        <td>${name(x)}</td>
        <td>${x.wins}</td><td>${x.cleared}</td><td>${x.sent}</td><td>${p?.trophies ?? "—"}</td></tr>`;
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
      : "Nobody's here to play another match."
    : `Waiting for ${playerById(s.hostId)?.name ?? "the host"} to start the next match…`;
}

// ------------------------------------------------------------------ layout

/** Size everyone else's bottles to the space beside yours (above it on phones), then yours to what's left. */
function layout(): void {
  if (shell.screen !== "game") return;
  const narrow = window.innerWidth <= 760;
  const v = app.view;
  const rivals = app.rivals.size;

  if (rivals) {
    const rc = rivalCell(rivals, narrow, !v?.own);
    for (const card of app.rivals.values()) {
      if (card.canvas.cell !== rc) card.canvas.resize(rc);
    }
  }

  // Your bottle: as tall as the window allows above its stats and (on touch screens) the pad.
  const padShown = getComputedStyle($("pad")).display !== "none";
  const top = $("own-col").getBoundingClientRect().top + window.scrollY;
  const below = 24 + 50 + (padShown ? 120 : 30) + 40;
  let cell = Math.floor((window.innerHeight - top - below) / 19.4);
  cell = Math.min(cell, Math.floor((window.innerWidth - (narrow ? 24 : 340)) / (COLS + 1.4)));
  cell = Math.max(12, Math.min(34, cell));
  if (cell !== app.ownCell) {
    app.ownCell = cell;
    ownCanvas.resize(cell);
  }
  const width = narrow ? "none" : `${Math.max(260, bottleSize(cell, true).w)}px`;
  for (const el of [
    $("own-col").querySelector<HTMLElement>(".own-head")!,
    $("own-col").querySelector<HTMLElement>(".own-stats")!,
    $("pad"),
  ]) {
    el.style.maxWidth = width;
  }
}

/** The biggest cell size at which every rival's bottle fits. On phones they share one short strip. */
function rivalCell(n: number, narrow: boolean, watching = false): number {
  if (narrow) {
    const w = window.innerWidth - 16;
    const most = watching ? 12 : Math.max(4, Math.min(7, Math.floor((window.innerHeight * 0.2 - 44) / 18.3)));
    for (let c = most; c > 4; c--) if (n * (bottleSize(c, false).w + 14) <= w) return c;
    return 4;
  }
  const box = document.querySelector<HTMLElement>(".rivals-col")!;
  const width = Math.max(200, box.clientWidth);
  const height = Math.max(240, window.innerHeight - box.getBoundingClientRect().top - window.scrollY - 24);
  for (let c = watching ? 30 : 24; c > 5; c--) {
    const { w, h } = bottleSize(c, false);
    const perRow = Math.max(1, Math.floor((width + 12) / (w + 12 + 16)));
    const rows = Math.ceil(n / perRow);
    if (rows * (h + 60) <= height) return c;
  }
  return 6;
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  window.addEventListener("resize", () => (shell.screen === "home" ? attract.resize() : layout()));
}

wire();
shell.start();
// The shell pings on each welcome and every 5 s during a round. Every bottle runs on the server's
// clock, so measure it more often, and in the lobby too, so it's settled before a round starts.
setInterval(() => shell.conn?.ping(), 2000);
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __pp: { app, controls, shell } });
