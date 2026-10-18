import { $, esc, store } from "@warrick/kit/client/dom";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import type { CpuLevel } from "../shared/ai";
import { MAX_BULLETS, MUZZLE, type MazeSize } from "../shared/constants";
import { COS, SIN } from "../shared/headings";
import {
  SETTING_CHOICES,
  rankPlayers,
  type ClientMsg,
  type GameState,
  type MazeChoice,
  type ServerMsg,
} from "../shared/protocol";
import type { WorldSnapshot } from "../shared/sim";
import { sfx } from "./audio";
import { Controls } from "./input";
import { LocalMatch } from "./local";
import { Renderer } from "./render";
import { NetRound } from "./round";

// ------------------------------------------------------------------ helpers

/**
 * Dev aid: `?as=bob` makes this tab a separate player (its own token, name and last game), so one browser
 * can be several players. Kept in sessionStorage, which is per tab, so it survives navigation and reloads.
 */
const devAs = (() => {
  if (!import.meta.env.DEV) return "";
  try {
    const as = new URLSearchParams(location.search).get("as") ?? sessionStorage.getItem("ra.as") ?? "";
    if (as) sessionStorage.setItem("ra.as", as);
    return as.replace(/\W/g, "").slice(0, 16);
  } catch {
    return "";
  }
})();

const MAZE_LABELS: Record<MazeChoice, string> = {
  auto: "Auto — grows with players",
  small: "Small (7×5)",
  medium: "Medium (9×6)",
  large: "Large (12×8)",
};

const HOW_TO_PLAY = `
  <div class="panel how-panel">
    <div class="panel-head"><h2>How to play</h2></div>
    <ul class="how">
      <li><kbd>↑</kbd><kbd>↓</kbd> drive, <kbd>←</kbd><kbd>→</kbd> turn, <kbd>Space</kbd> fire. On a phone: the stick and the Fire button.</li>
      <li>Tap a turn key to nudge your aim; hold it to spin.</li>
      <li>You have 5 bullets. Each bounces off walls for 6 seconds, then you get it back.</li>
      <li>One hit kills — and that includes your own bullets coming back.</li>
      <li>Last tank standing scores a point. A new maze every round.</li>
    </ul>
  </div>`;

// ------------------------------------------------------------------ app state

const app = {
  round: null as NetRound | null,
  /** Input sequence number for this connection; the server acks the latest it has applied. */
  seq: 0,
  /** The round in progress that came with the welcome: it's started once the welcome's state is in. */
  welcome: null as { world: WorldSnapshot | null } | null,
  /** Local time until which a status banner (GO!, you were hit) stays up. */
  flash: { html: "", until: 0 },
  lastCount: -1,
  /** Which tanks were alive when the HUD and scores were last drawn. */
  aliveKey: "",
  sandbox: null as LocalMatch | null,
};

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "ricochet-alley",
  title: "Ricochet Alley",
  prefix: devAs ? `ra.${devAs}` : "ra",
  logo: "RICOCHET<br />ALLEY",
  tagline: "Tank battles in a maze. Bullets bounce.<br />No accounts — just share a code.",
  placeholder: "Commander",
  footer: "In the spirit of <em>Combat</em> (1977) and <em>Tank Trouble</em>.",
  settings: {
    target: { label: "First to", fmt: (v: number) => `${v} point${v === 1 ? "" : "s"}` },
    maze: { label: "Maze", fmt: (v: MazeChoice) => MAZE_LABELS[v] ?? v },
  },
  choices: SETTING_CHOICES,
  onWelcome,
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s) =>
    s.phase !== "lobby" && s.phase !== "gameover" && !shell.mine?.spectator ? "Leave this game? Your points go with you." : null,
  isLive: (s) => s.phase === "playing",
});
// How to play sits beside the chat in the lobby.
$("screen-lobby").querySelector(".chat-panel")!.insertAdjacentHTML("beforebegin", HOW_TO_PLAY);

if (devAs && !store("name")) store("name", devAs);
const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attractRenderer = new Renderer($<HTMLCanvasElement>("attract"));
const attract = new LocalMatch(attractRenderer, { human: false, cpus: ["hard", "normal", "hard", "normal"], size: "large", sound: false });

const serverNow = () => shell.serverNow();
const playerById = (id: string | null | undefined) => shell.player(id);
const canHost = (s: GameState) => shell.canHost(s);

const controls = new Controls(
  {
    change: (bits) => {
      if (app.sandbox) {
        app.sandbox.humanBits = bits;
        return;
      }
      app.seq++;
      app.round?.input(app.seq, bits);
      shell.send({ t: "in", s: app.seq, b: bits });
    },
    fire,
    active: () =>
      shell.screen === "game" && (!!app.sandbox || shell.state?.phase === "playing" || shell.state?.phase === "countdown"),
    heading: () => {
      if (app.sandbox) return app.sandbox.world.tanks[0].alive ? app.sandbox.world.tanks[0].h : null;
      return app.round?.myAlive ? (app.round.predictor.pose?.h ?? null) : null;
    },
  },
  { stick: $("stick"), knob: $("stick-knob"), fire: $("touch-fire") },
);

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "game") {
    $("touch").hidden = !matchMedia("(pointer: coarse)").matches;
    layoutStage();
  } else {
    controls.releaseAll();
  }
  if (screen === "home") resizeAttract();
}

/** Left the game, or lost it for good. */
function onReset(): void {
  app.round = null;
  app.welcome = null;
  $("gameover").hidden = true;
}

// ------------------------------------------------------------------ messages

function onWelcome(msg: ServerMsg): void {
  if (msg.t !== "welcome") return;
  // A new connection starts input numbering over.
  app.seq = 0;
  app.round = null;
  app.welcome = { world: msg.world };
}

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case "round":
      startRound(msg.world);
      break;
    case "f":
      app.round?.frame(msg, performance.now());
      break;
  }
}

function onState(s: GameState, prev: GameState | null): void {
  if (s.phase === "lobby") app.round = null;
  if (prev?.phase !== s.phase) onPhase(prev, s);
  document.title = s.phase === "lobby" ? `Ricochet Alley · ${s.code}` : `Round ${s.round} · Ricochet Alley`;
  render();
  const welcome = app.welcome;
  if (welcome) {
    app.welcome = null;
    if (welcome.world) startRound(welcome.world);
    // Re-send whatever is held right now.
    if (controls.bits) {
      app.seq++;
      app.round?.input(app.seq, controls.bits);
      shell.send({ t: "in", s: app.seq, b: controls.bits });
    }
  }
}

function onPhase(prev: GameState | null, s: GameState): void {
  if (s.phase === "playing" && prev?.phase === "countdown") {
    sfx.go();
    flash(`<span class="big">GO!</span>`, 700);
  }
  if (s.phase === "roundover" && s.roundWinnerId === shell.me) sfx.win();
}

function startRound(world: WorldSnapshot): void {
  const s = shell.state;
  if (!s?.setup) return;
  app.round = new NetRound(s.setup, world, shell.me, app.seq, controls.bits, {
    tankInfo: (i) => {
      const p = playerById(s.setup!.tanks[i]);
      return { name: p?.name ?? "?", color: p?.color ?? "#888888" };
    },
    fired: (b, mine) => {
      // Your own shot already flashed and banged when you pressed fire.
      if (mine) return;
      renderer.muzzle(b.x, b.y, performance.now());
      sfx.fire();
    },
    hit: (owner, victim, x, y) => {
      const r = app.round;
      if (!r) return;
      renderer.explode(x, y, playerById(r.setup.tanks[victim])?.color ?? "#ffffff", performance.now());
      sfx.boom();
      if (victim === r.me) {
        const by = playerById(r.setup.tanks[owner]);
        flash(owner === victim ? `<span class="big">OOPS</span>Your own bullet got you.` : `<span class="big">HIT</span>${esc(by?.name ?? "Someone")} got you.`, 1800);
      }
    },
    bounced: (x, y) => {
      renderer.spark(x, y, performance.now());
      bounceSound();
    },
  });
  renderer.setMaze(s.setup.maze, s.setup.theme);
  app.lastCount = -1;
  layoutStage();
  render();
}

let lastBounce = 0;
function bounceSound(): void {
  const now = performance.now();
  if (now - lastBounce < 60) return;
  lastBounce = now;
  sfx.bounce();
}

function fire(): void {
  if (app.sandbox) {
    app.sandbox.requestFire();
    return;
  }
  const r = app.round;
  const s = shell.state;
  if (!r || !s || s.phase !== "playing" || !r.myAlive) return;
  if (r.myBullets() >= MAX_BULLETS) {
    sfx.empty();
    const pips = $("hud-pips");
    pips.classList.remove("empty");
    void pips.offsetWidth;
    pips.classList.add("empty");
    return;
  }
  shell.send({ t: "in", s: app.seq, b: controls.bits, f: 1 });
  const p = r.predictor.pose;
  if (p) renderer.muzzle(p.x + COS[p.h] * MUZZLE, p.y + SIN[p.h] * MUZZLE, performance.now());
  sfx.fire();
}

function flash(html: string, ms: number): void {
  app.flash = { html, until: performance.now() + ms };
}

// ------------------------------------------------------------------ frame loop

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game") return;
  controls.update();
  if (app.sandbox) {
    app.sandbox.frame(now);
    renderSandboxHud();
    return;
  }
  const r = app.round;
  const s = shell.state;
  if (r && s) {
    r.update(now, s.phase === "playing", () => controls.update());
    const { tanks, bullets } = r.draw(now);
    renderer.draw({ tanks, bullets, findMe: s.phase === "countdown", names: s.phase === "countdown" || s.phase === "roundover" }, now);
    renderPips(r);
    // Tanks fall between state messages; keep the HUD and the score list in step.
    const key = r.alive.join();
    if (key !== app.aliveKey) {
      app.aliveKey = key;
      renderGame(s);
    }
  }
  renderBanner(now);
}

// ------------------------------------------------------------------ game

/** The shell draws the lobby; this draws the game screen. */
function render(): void {
  const s = shell.state;
  if (s && s.phase !== "lobby" && shell.screen === "game") renderGame(s);
}

function renderGame(s: GameState): void {
  renderHud(s);
  renderPlayers(s);
  renderGameOver(s);
}

function renderHud(s: GameState): void {
  $("hud-round").textContent = s.round ? String(s.round) : "—";
  $("hud-target").textContent = String(s.settings.target);
  const r = app.round;
  const mine = shell.mine;
  const left = r?.aliveCount ?? 0;
  let html: string;
  if (mine?.spectator) {
    const full = s.players.filter((p) => !p.spectator).length >= MAX_PLAYERS;
    html = full ? `<span class="dim">Watching — the game is full (${MAX_PLAYERS} tanks)</span>` : `<span class="dim">Watching — you're in from the next round</span>`;
  } else if (s.phase === "countdown") {
    html = `<span class="who">Round ${s.round}</span><span class="dim">Get ready…</span>`;
  } else if (s.phase === "playing") {
    if (r && r.me >= 0 && !r.myAlive) html = `<span class="who">You're out</span><span class="dim">${left} tank${left === 1 ? "" : "s"} left</span>`;
    else if (r && r.me < 0) html = `<span class="dim">You sat this round out — you're in next round</span>`;
    else html = `<span class="who">Round ${s.round}</span><span class="dim">${left} tanks left</span>`;
  } else if (s.phase === "roundover") {
    const w = playerById(s.roundWinnerId);
    html = w ? `<span class="chip" style="background:${w.color}"></span><span class="who">${esc(w.name)} wins the round</span>` : `<span class="who">Draw — nobody survived</span>`;
  } else {
    html = `<span class="who">Game over</span>`;
  }
  const el = $("hud-status");
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

function renderPips(r: NetRound): void {
  const left = r.me >= 0 && r.myAlive ? MAX_BULLETS - r.myBullets() : 0;
  const key = String(left);
  const el = $("hud-pips");
  if (el.dataset.left === key) return;
  el.dataset.left = key;
  el.innerHTML = Array.from({ length: MAX_BULLETS }, (_, i) => `<i class="${i < left ? "" : "out"}"></i>`).join("");
  el.setAttribute("aria-label", `${left} of ${MAX_BULLETS} bullets ready`);
  $("touch-fire").classList.toggle("out", left === 0);
}

function renderPlayers(s: GameState): void {
  const r = app.round;
  const ranked = [...s.players].sort((a, b) => Number(a.spectator) - Number(b.spectator) || rankPlayers(a, b));
  const html = ranked
    .map((p) => {
      const i = r ? r.setup.tanks.indexOf(p.id) : -1;
      const out = s.phase !== "lobby" && (i < 0 || (r && !r.alive[i]));
      const tags = [
        p.id === shell.me ? `<span class="tag tag-you">you</span>` : "",
        p.cpu ? `<span class="tag">CPU</span>` : "",
        p.spectator ? `<span class="tag">next round</span>` : "",
        !p.cpu && !p.connected ? `<span class="tag">away</span>` : "",
      ].join("");
      const pct = Math.min(100, (p.score / s.settings.target) * 100);
      return `<li class="${[out ? "dead" : "", p.id === shell.me ? "me" : "", !p.cpu && !p.connected ? "offline" : ""].join(" ")}">
        <span class="chip" style="background:${p.color}"></span>
        <span class="pname">${esc(p.name)} ${tags}</span>
        <span class="pts">${p.score}</span>
        <span class="bar"><i style="width:${pct}%;background:${p.color}"></i></span></li>`;
    })
    .join("");
  const el = $("game-players");
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

function renderBanner(now: number): void {
  const s = shell.state;
  const el = $("banner");
  let html = "";
  let cls = "banner";
  if (s?.phase === "countdown" && s.phaseDeadline) {
    const secs = Math.max(1, Math.ceil((s.phaseDeadline - serverNow()) / 1000));
    if (secs !== app.lastCount) {
      app.lastCount = secs;
      sfx.beep();
    }
    html = `<span class="big">${secs}</span><span class="sub">Round ${s.round}</span>`;
    cls += " count";
  } else if (s?.phase === "roundover") {
    const w = playerById(s.roundWinnerId);
    const champ = s.players.find((p) => !p.spectator && p.score >= s.settings.target);
    const next = s.phaseDeadline ? Math.max(0, Math.ceil((s.phaseDeadline - serverNow()) / 1000)) : 0;
    const title = w ? (w.id === shell.me ? "You win the round!" : `${esc(w.name)} wins the round`) : "Draw!";
    const sub = champ ? `…and that's the game.` : w ? `${w.score} of ${s.settings.target} · next round in ${next}` : `Nobody scores · next round in ${next}`;
    html = `<span class="big" style="${w ? `color:${w.color}` : ""}">${title}</span><span class="sub">${sub}</span>`;
  } else if (app.flash.until > now) {
    html = app.flash.html;
    cls += " flash";
  }
  if (el.dataset.html === html + cls) return;
  el.dataset.html = html + cls;
  el.className = cls;
  el.innerHTML = html;
  el.hidden = !html;
}

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover";
  $("gameover").hidden = !open;
  if (!open) return;
  const ranked = s.players.filter((p) => !p.spectator).sort(rankPlayers);
  const best = ranked[0];
  $("gameover-winner").innerHTML = best ? `<b style="color:${best.color}">${esc(best.name)}</b> rules the alley.` : "";
  $("gameover-rows").innerHTML = ranked
    .map(
      (p, i) => `<tr>
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${p.color}"></span>${esc(p.name)}</span></td>
        <td>${p.score}</td><td>${p.kills}</td><td>${p.selfHits}</td></tr>`,
    )
    .join("");
  const back = $<HTMLButtonElement>("gameover-lobby");
  const host = canHost(s);
  back.disabled = !host;
  back.textContent = host ? "Back to lobby" : `Waiting for ${esc(playerById(s.hostId)?.name ?? "host")}…`;
  $("gameover-hint").textContent = host ? "" : "Only the host can take everyone back to the lobby.";
}

// ------------------------------------------------------------------ layout

function layoutStage(): void {
  if (shell.screen !== "game") return;
  const col = $("stage-col");
  const stage = $("stage");
  const top = stage.getBoundingClientRect().top;
  const touch = $("touch");
  const below = (touch.hidden ? 0 : touch.offsetHeight + 10) + ($("keys-hint").offsetHeight || 0) + 28;
  renderer.fit(col.clientWidth - 4, Math.max(200, window.innerHeight - Math.max(0, top) - below));
}

function resizeAttract(): void {
  // Cover the whole screen: fit to the larger box, and let CSS crop the overflow.
  const w = window.innerWidth;
  const h = window.innerHeight;
  attractRenderer.fit(Math.max(w, h * 1.5), Math.max(h, w / 1.5));
  attractRenderer.canvas.style.width = "100%";
  attractRenderer.canvas.style.height = "100%";
}

// ------------------------------------------------------------------ sandbox (dev only)

function startSandbox(params: URLSearchParams): void {
  const cpus = (params.get("cpus") ?? "normal,normal,normal").split(",") as CpuLevel[];
  app.sandbox = new LocalMatch(renderer, { human: true, cpus, size: (params.get("size") ?? "medium") as MazeSize, sound: true });
  shell.showScreen("game");
  $("hud-target").textContent = "—";
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyR" && app.sandbox) app.sandbox.newRound(performance.now());
  });
}

function renderSandboxHud(): void {
  const sb = app.sandbox!;
  const left = sb.world.tanks[0].alive ? MAX_BULLETS - sb.field.countOf(0) : 0;
  const el = $("hud-pips");
  if (el.dataset.left !== String(left)) {
    el.dataset.left = String(left);
    el.innerHTML = Array.from({ length: MAX_BULLETS }, (_, i) => `<i class="${i < left ? "" : "out"}"></i>`).join("");
  }
  $("hud-round").textContent = String(sb.round);
  const status = `<span class="dim">Sandbox · R for a new maze · wins ${sb.wins.join(" / ")}</span>`;
  if ($("hud-status").innerHTML !== status) $("hud-status").innerHTML = status;
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  window.addEventListener("resize", () => (shell.screen === "home" ? resizeAttract() : layoutStage()));
  new ResizeObserver(() => layoutStage()).observe($("stage-col"));
  // While the connection is down no frames come, so the clock's idea of the server's timing goes stale.
  new MutationObserver(() => {
    if ($("game-conn").dataset.status !== "open") app.round?.clock.reset();
  }).observe($("game-conn"), { attributes: true, attributeFilter: ["data-status"] });

  // Clicking the stage or a tank list shouldn't leave a button focused (it would swallow Space).
  $("stage").addEventListener("pointerdown", () => (document.activeElement as HTMLElement | null)?.blur());
}

wire();
shell.start();
const params = new URLSearchParams(location.search);
if (import.meta.env.DEV && params.has("sandbox")) startSandbox(params);
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __ra: { app, shell, renderer, controls } });
