import { unlockAudio } from "@warrick/kit/client/audio";
import { $, $$, esc, toast } from "@warrick/kit/client/dom";
import { formatClock } from "@warrick/kit/client/format";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { TICK_MS, TURRET_Y } from "../shared/constants";
import {
  SETTING_CHOICES,
  rankPlayers,
  type Aim,
  type ClientMsg,
  type GameState,
  type PlayerState,
  type ServerMsg,
  type ShotMessage,
} from "../shared/protocol";
import { maxPowerFor, type World } from "../shared/sim";
import { SHOP_ORDER, WEAPONS, WEAPON_ORDER, shopDef, weaponCount, type ShopId, type WeaponId } from "../shared/weapons";
import { worldFromState } from "../shared/world-state";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { Renderer, type DrawOpts, type TankInfo } from "./render";

// ------------------------------------------------------------------ helpers

function money(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

// ------------------------------------------------------------------ app state

interface Anim {
  world: World;
  after: GameState;
  start: number;
  cursor: number;
}

const app = {
  aim: { angle: 60, power: 500, weapon: "baby_missile" } as Aim,
  turnKey: "",
  firing: false,
  world: null as World | null,
  anim: null as Anim | null,
  pending: null as GameState | null,
  dragging: false,
  aimGuide: null as DrawOpts["aimGuide"],
  bannerUntil: 0,
  shopRound: -1,
};

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "crater-club",
  title: "Crater Club",
  prefix: "cc",
  logo: "CRATER<br />CLUB",
  tagline: "Turn-based artillery for friends.<br />No accounts — just share a code.",
  placeholder: "Commander",
  footer: "A love letter to <em>Scorched Earth</em> (1991).",
  settings: {
    rounds: { label: "Rounds", fmt: (v: number) => String(v) },
    startCash: { label: "Start cash", fmt: (v: number) => money(v) },
    maxWind: { label: "Wind", fmt: (v: number) => ({ 0: "Off", 5: "Light", 10: "Normal", 20: "Gale" })[v] ?? String(v) },
    walls: {
      label: "Walls",
      fmt: (v: string) => ({ open: "Open — shots fly off", bounce: "Rubber — shots bounce", wrap: "Wrap-around" })[v] ?? v,
    },
    turnSeconds: { label: "Turn timer", fmt: (v: number) => (v ? `${v} seconds` : "No limit") },
  },
  choices: SETTING_CHOICES,
  // While a shot is in the air, the state after it waits until the animation lands.
  intercept: (msg) => {
    if (msg.t !== "state" || !app.anim) return false;
    app.pending = msg.state;
    return true;
  },
  onWelcome: () => {
    app.firing = false;
    app.anim = null;
    app.pending = null;
  },
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s): string | null =>
    s.phase !== "lobby" && s.phase !== "gameover" ? "Leave this game? Your tank stays behind." : null,
});
const renderer = new Renderer($<HTMLCanvasElement>("game-canvas"));
const attract = new Attract($<HTMLCanvasElement>("attract"));

const serverNow = () => shell.serverNow();
const me = (s = shell.state): PlayerState | undefined => s?.players.find((p) => p.id === shell.me);
const playerById = (id: string | null | undefined) => shell.player(id);
const isMyTurn = (s = shell.state) => !!s && s.phase === "playing" && !s.resolving && s.turnPlayerId === shell.me && !app.anim;
const canHost = (s = shell.state) => shell.canHost(s);

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen === "game") layoutStage();
  if (screen === "home") attract.resize();
}

/** Left the game, or lost it for good. */
function onReset(): void {
  app.anim = null;
  app.pending = null;
  app.world = null;
  $("shop").hidden = true;
  $("gameover").hidden = true;
}

// ------------------------------------------------------------------ messages

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case "shot":
      startShot(msg.shot, msg.state);
      break;
    case "aim": {
      if (msg.id === shell.me) break;
      for (const s of [shell.state, app.pending]) {
        const p = s?.players.find((p) => p.id === msg.id);
        if (p) p.aim = msg.aim;
      }
      if (shell.state?.turnPlayerId === msg.id) renderHud();
      break;
    }
    case "error":
      // The shell has shown the message.
      app.firing = false;
      renderControls();
      break;
  }
}

function onState(s: GameState, prev: GameState | null): void {
  if (!prev || prev.round !== s.round || prev.phase === "lobby") renderer.clearTracers();
  app.world = s.terrain.length ? worldFromState(s) : null;

  const key = `${s.round}:${s.shotCount}:${s.turnPlayerId}`;
  if (isMyTurn(s) && key !== app.turnKey) {
    app.turnKey = key;
    const p = me(s)!;
    app.aim = { ...p.aim };
    app.firing = false;
    sfx.turn();
    flashBanner(`<span class="big">YOUR TURN</span>`, 1300);
  }
  if (!isMyTurn(s)) app.firing = false;

  if (isMyTurn(s)) document.title = "▶ Your turn — Crater Club";
  if (s.phase !== "lobby") renderGame(s);
}

function startShot(shot: ShotMessage, after: GameState): void {
  if (app.anim) finishShot(true);
  const base = shell.state;
  if (!base?.terrain.length) {
    shell.applyState(after);
    return;
  }
  const shooter = base.players.find((p) => p.id === shot.shooterId);
  if (shooter) shooter.aim = { angle: shot.angle, power: shot.power, weapon: shot.weapon };
  const world = worldFromState(base);
  world.fire(shot);
  renderer.newShot();
  app.anim = { world, after, start: performance.now(), cursor: 0 };
  app.world = world;
  app.firing = false;
  app.dragging = false;
  app.aimGuide = null;
  if (shell.state) renderGame(shell.state);
}

/** Stop animating: snap to the server's result (fast-forwarding if needed). */
function finishShot(skip = false): void {
  const a = app.anim;
  if (!a) return;
  if (skip) {
    a.world.runToEnd();
    a.cursor = a.world.events.length;
  }
  app.anim = null;
  shell.applyState(a.after);
  if (app.pending) {
    const next = app.pending;
    app.pending = null;
    shell.applyState(next);
  }
}

function drainEvents(a: Anim, now: number): void {
  const evs = a.world.events;
  for (; a.cursor < evs.length; a.cursor++) {
    const ev = evs[a.cursor];
    renderer.onEvent(ev, a.world, now, (id) => playerById(id)?.color ?? "#ffffff");
    if (ev.type === "fire") sfx.fire();
    else if (ev.type === "explode") ev.dirt ? sfx.dirt() : sfx.boom(ev.r);
    else if (ev.type === "split") sfx.split();
    else if (ev.type === "chute") sfx.chute();
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

  const a = app.anim;
  if (a) {
    const target = Math.floor((now - a.start) / TICK_MS);
    let steps = 0;
    while (a.world.tick < target && !a.world.done && !a.world.timedOut && steps++ < 240) a.world.step();
    drainEvents(a, now);
    if (a.world.done || a.world.timedOut) finishShot();
  }
  if (app.world && shell.state) renderer.draw(app.world, drawOpts(shell.state), now);
  tickClocks();
}

function drawOpts(s: GameState): DrawOpts {
  const tanks = new Map<string, TankInfo>();
  const mine = isMyTurn(s);
  for (const p of s.players) {
    if (!p.tank) continue;
    tanks.set(p.id, {
      name: p.name,
      color: p.color,
      angle: p.id === shell.me && mine ? app.aim.angle : p.aim.angle,
      active: s.phase === "playing" && s.turnPlayerId === p.id,
      you: p.id === shell.me,
    });
  }
  const shooter = playerById(app.anim ? app.anim.world.shooterId : s.turnPlayerId);
  return { theme: s.theme, tanks, labels: true, aimGuide: app.aimGuide, shooterColor: shooter?.color };
}

function tickClocks(): void {
  const s = shell.state;
  if (!s) return;
  const clock = document.querySelector<HTMLElement>("#hud-turn .clock");
  if (clock) {
    const left =
      s.turnDeadline && s.phase === "playing" && !s.resolving && !app.anim ? Math.max(0, s.turnDeadline - serverNow()) : null;
    const text = left === null ? "" : formatClock(left);
    if (clock.textContent !== text) clock.textContent = text;
    clock.classList.toggle("low", left !== null && left < 10000);
  }
  if (s.phase === "shop" || s.phase === "roundover") {
    const secs = s.phaseDeadline ? Math.max(0, Math.ceil((s.phaseDeadline - serverNow()) / 1000)) : 0;
    for (const el of $$("[data-countdown]")) {
      const text = String(secs);
      if (el.textContent !== text) el.textContent = text;
    }
  }
  if (app.bannerUntil && performance.now() > app.bannerUntil) {
    app.bannerUntil = 0;
    renderBanner();
  }
}

// ------------------------------------------------------------------ game

function renderGame(s: GameState): void {
  renderHud();
  renderPlayers(s);
  renderControls();
  renderBanner();
  renderShop(s);
  renderGameOver(s);
}

function renderHud(): void {
  const s = shell.state;
  if (!s || s.phase === "lobby") return;
  const turn = playerById(s.turnPlayerId);
  const turnEl = $("hud-turn");
  let who = "";
  if (s.phase === "playing" && turn) {
    const label =
      app.anim || s.resolving
        ? `${esc(turn.name)} fires!`
        : turn.id === shell.me
          ? "Your turn!"
          : `${esc(turn.name)}'s turn${turn.cpu ? " (thinking…)" : ""}`;
    who = `<span class="chip" style="background:${turn.color}"></span><span class="who">${label}</span>`;
  } else if (s.phase === "roundover") who = `<span class="who">Round over</span>`;
  else if (s.phase === "shop") who = `<span class="who">Shopping break</span>`;
  else if (s.phase === "gameover") who = `<span class="who">Game over</span>`;
  const html = `${who}<span class="clock"></span>`;
  if (turnEl.dataset.html !== html) {
    turnEl.innerHTML = html;
    turnEl.dataset.html = html;
  }

  const aim = turn ? (turn.id === shell.me && isMyTurn(s) ? app.aim : turn.aim) : null;
  const tank = turn?.tank;
  $("hud-angle").textContent = aim ? `${aim.angle}°` : "—";
  const cap = tank ? maxPowerFor(tank.health) : 1000;
  $("hud-power").textContent = aim ? (cap < 1000 ? `${aim.power}/${cap}` : String(aim.power)) : "—";
  $("hud-power").title = cap < 1000 ? `Damaged: max power ${cap} at ${tank!.health} health` : "";
  $("hud-weapon").textContent = aim ? WEAPONS[aim.weapon].name : "—";
  const canPick = isMyTurn(s) && !app.firing;
  const weaponBtn = $("hud-weapon-btn");
  weaponBtn.classList.toggle("can-pick", canPick);
  weaponBtn.setAttribute("aria-disabled", String(!canPick));
  weaponBtn.title = canPick ? "Choose a weapon (or press Tab)" : "";
  if (!canPick) closeWeaponMenu();
  $("hud-wind").textContent = s.wind === 0 ? "Calm" : `${s.wind > 0 ? "→" : "←"} ${Math.abs(s.wind)}`;
  $("hud-round").textContent = s.round ? `${s.round}/${s.settings.rounds}` : "—";
}

function renderPlayers(s: GameState): void {
  const order = s.turnOrder.length ? s.turnOrder : s.players.map((p) => p.id);
  const rows = order
    .map((id) => s.players.find((p) => p.id === id))
    .filter((p): p is PlayerState => !!p && !p.spectator)
    .map((p) => {
      const hp = p.tank?.health ?? 0;
      const cls = [
        s.turnPlayerId === p.id && s.phase === "playing" ? "turn" : "",
        p.tank && !p.tank.alive ? "dead" : "",
        !p.cpu && !p.connected ? "offline" : "",
      ].join(" ");
      const tag = p.id === shell.me ? ` <span class="tag tag-you">you</span>` : p.cpu ? ` <span class="tag">CPU</span>` : "";
      const shield = p.tank?.alive && p.tank.shield > 0 ? ` <span class="tag" title="Shield">🛡 ${p.tank.shield}</span>` : "";
      return `<li class="${cls}">
        <span class="chip" style="background:${p.color}"></span>
        <span class="pname">${esc(p.name)}${tag}${shield}</span>
        <span class="cash">${money(p.money)}</span>
        <div class="hp"><i class="${hp > 60 ? "" : hp > 30 ? "mid" : "low"}" style="width:${hp}%"></i></div>
      </li>`;
    });
  const spectators = s.players.filter((p) => p.spectator);
  if (spectators.length) {
    rows.push(`<li class="muted" style="display:block">Watching: ${spectators.map((p) => esc(p.name)).join(", ")}</li>`);
  }
  $("game-players").innerHTML = rows.join("");
}

function renderControls(): void {
  const s = shell.state;
  if (!s || s.phase === "lobby") return;
  const p = me(s);
  const controls = $("controls");
  const waiting = $("waiting");
  const playing = s.phase === "playing";
  const hasTank = !!p?.tank?.alive && !p.spectator;

  controls.hidden = !playing || !hasTank;
  waiting.hidden = !playing || hasTank;
  if (playing && !hasTank) {
    waiting.textContent = p?.spectator
      ? "You're watching this game. You'll get a tank when the host starts the next one."
      : "Your tank is scrap metal. Hang tight until the next round.";
  }
  if (!playing || !hasTank || !p) return;

  const mine = isMyTurn(s) && !app.firing;
  controls.classList.toggle("disabled", !mine);
  $("stage").classList.toggle("aiming", mine);

  const maxPower = maxPowerFor(p.tank!.health);
  if (app.aim.power > maxPower) app.aim.power = maxPower;
  if (weaponCount(p.inventory, app.aim.weapon) <= 0) app.aim.weapon = "baby_missile";

  const angle = $<HTMLInputElement>("ctl-angle");
  const power = $<HTMLInputElement>("ctl-power");
  // Range inputs run left-to-right; angle 180 points left, so mirror it.
  angle.value = String(180 - (mine ? app.aim.angle : p.aim.angle));
  power.max = String(maxPower);
  power.value = String(mine ? app.aim.power : p.aim.power);
  $("ctl-power-label").textContent = maxPower < 1000 ? `Power · max ${maxPower}` : "Power";

  const select = $<HTMLSelectElement>("ctl-weapon");
  const owned = WEAPON_ORDER.filter((w) => weaponCount(p.inventory, w) > 0);
  const key = owned.map((w) => `${w}:${p.inventory[w] ?? "∞"}`).join(",");
  if (select.dataset.key !== key) {
    select.dataset.key = key;
    select.innerHTML = owned
      .map((w) => `<option value="${w}">${WEAPONS[w].name} (${w === "baby_missile" ? "∞" : p.inventory[w]})</option>`)
      .join("");
  }
  select.value = app.aim.weapon;
  $<HTMLButtonElement>("ctl-fire").disabled = !mine;
}

function flashBanner(html: string, ms: number): void {
  app.bannerUntil = performance.now() + ms;
  const el = $("banner");
  el.innerHTML = html;
  el.classList.add("flash");
  el.hidden = false;
}

function renderBanner(): void {
  const s = shell.state;
  const el = $("banner");
  if (!s) return;
  if (s.phase === "roundover" && !app.anim) {
    el.classList.remove("flash");
    const winner = playerById(s.roundWinnerId);
    const head = winner
      ? `<span class="big" style="color:${winner.color}">${esc(winner.name)} wins round ${s.round}</span>`
      : `<span class="big">Round ${s.round}: nobody survived</span>`;
    const next = s.round >= s.settings.rounds ? "Final results" : "Arms dealer opens";
    el.innerHTML = `${head}${next} in <span data-countdown></span>s`;
    el.hidden = false;
    return;
  }
  const watching = !me(s) || me(s)!.spectator;
  if (s.phase === "shop" && watching) {
    el.classList.remove("flash");
    el.innerHTML = `<span class="big">Shopping break</span>Next round in <span data-countdown></span>s`;
    el.hidden = false;
    return;
  }
  if (app.bannerUntil) return; // transient banner still showing
  el.hidden = true;
}

// ------------------------------------------------------------------ shop

function renderShop(s: GameState): void {
  const p = me(s);
  const open = s.phase === "shop" && !!p && !p.spectator;
  $("shop").hidden = !open;
  if (!open || !p) {
    app.shopRound = -1;
    return;
  }
  const grid = $("shop-grid");
  if (app.shopRound !== s.round) {
    app.shopRound = s.round;
    grid.innerHTML = SHOP_ORDER.map((id) => {
      const d = shopDef(id);
      return `<div class="item" data-item="${id}">
        <h3>${d.name}</h3><span class="own"></span>
        <p>${esc(d.desc)}</p>
        <span class="price">${money(d.price)}${d.bundle > 1 ? ` <span class="muted">for ${d.bundle}</span>` : ""}</span>
        <div class="buy-row">
          <button class="btn btn-small" data-sell="${id}" aria-label="Sell ${d.name}">Sell</button>
          <button class="btn btn-small btn-primary" data-buy="${id}" aria-label="Buy ${d.name}">Buy</button>
        </div>
      </div>`;
    }).join("");
  }
  for (const card of $$("#shop-grid .item")) {
    const id = card.dataset.item as ShopId;
    const d = shopDef(id);
    const owned = p.inventory[id] ?? 0;
    card.classList.toggle("owned", owned > 0);
    card.querySelector(".own")!.textContent = owned ? `×${owned}` : "";
    card.querySelector<HTMLButtonElement>("[data-buy]")!.disabled = p.money < d.price;
    card.querySelector<HTMLButtonElement>("[data-sell]")!.disabled = owned < d.bundle;
  }
  $("shop-cash").textContent = money(p.money);
  $("shop-sub").innerHTML =
    s.round === 0
      ? `Spend your starting cash before round 1. It starts in <span data-countdown></span>s or when everyone is ready.`
      : `Round ${s.round} done. Round ${s.round + 1} starts in <span data-countdown></span>s or when everyone is ready.`;
  const ready = $<HTMLButtonElement>("shop-ready");
  ready.textContent = p.ready ? "Not ready yet" : "Ready";
  ready.classList.toggle("btn-primary", !p.ready);
  const waitingFor = s.players.filter((o) => !o.spectator && !o.cpu && o.connected && !o.ready).map((o) => esc(o.name));
  $("shop-waiting").innerHTML = waitingFor.length ? `Waiting for ${waitingFor.join(", ")}` : "Everyone's ready";
}

// ------------------------------------------------------------------ game over

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover";
  $("gameover").hidden = !open;
  if (!open) return;
  const ranked = s.players.filter((p) => !p.spectator).sort(rankPlayers);
  const best = ranked[0];
  $("gameover-winner").innerHTML = best ? `<b style="color:${best.color}">${esc(best.name)}</b> rules the crater.` : "";
  $("gameover-rows").innerHTML = ranked
    .map(
      (p, i) => `<tr>
        <td>${i + 1}</td>
        <td><span class="pcell"><span class="chip" style="background:${p.color}"></span>${esc(p.name)}</span></td>
        <td>${p.score}</td><td>${p.wins}</td><td>${p.kills}</td><td>${p.damage}</td></tr>`,
    )
    .join("");
  const back = $<HTMLButtonElement>("gameover-lobby");
  const host = canHost(s);
  back.disabled = !host;
  back.textContent = host ? "Back to lobby" : `Waiting for ${playerById(s.hostId)?.name ?? "host"}…`;
}

// ------------------------------------------------------------------ log & chat

// ------------------------------------------------------------------ aiming & firing

let aimSendTimer = 0;
let lastAimSent = 0;

function setAim(patch: Partial<Aim>): void {
  const s = shell.state;
  const p = me(s);
  if (!s || !p?.tank || !isMyTurn(s) || app.firing) return;
  const next = { ...app.aim, ...patch };
  next.angle = Math.min(180, Math.max(0, Math.round(next.angle)));
  next.power = Math.min(maxPowerFor(p.tank.health), Math.max(0, Math.round(next.power)));
  if (weaponCount(p.inventory, next.weapon) <= 0) next.weapon = "baby_missile";
  app.aim = next;
  renderHud();
  renderControls();
  // Let the others watch the barrel move, without flooding the socket.
  const wait = 90 - (performance.now() - lastAimSent);
  clearTimeout(aimSendTimer);
  const sendNow = () => {
    lastAimSent = performance.now();
    shell.send({ t: "aim", aim: app.aim });
  };
  if (wait <= 0) sendNow();
  else aimSendTimer = window.setTimeout(sendNow, wait);
}

let fireWatchdog = 0;

function fire(): void {
  if (!isMyTurn() || app.firing) return;
  unlockAudio();
  clearTimeout(aimSendTimer);
  if (!shell.send({ t: "fire", aim: app.aim })) {
    toast("Not connected — reconnecting, try again in a moment");
    return;
  }
  app.firing = true;
  app.dragging = false;
  app.aimGuide = null;
  renderControls();
  // If the server never answers (dropped connection), give the controls back.
  clearTimeout(fireWatchdog);
  fireWatchdog = window.setTimeout(() => {
    if (!app.firing) return;
    app.firing = false;
    renderControls();
    toast("The server didn't answer — try firing again");
  }, 6000);
}

function ownedWeapons(p: PlayerState): WeaponId[] {
  return WEAPON_ORDER.filter((w) => weaponCount(p.inventory, w) > 0);
}

function cycleWeapon(dir: 1 | -1): void {
  const p = me();
  if (!p) return;
  const owned = ownedWeapons(p);
  const i = owned.indexOf(app.aim.weapon);
  setAim({ weapon: owned[(i + dir + owned.length) % owned.length] });
}

function openWeaponMenu(): void {
  const p = me();
  if (!p || !isMyTurn() || app.firing) return;
  const menu = $("weapon-menu");
  const btn = $("hud-weapon-btn");
  menu.innerHTML =
    ownedWeapons(p)
      .map(
        (w) => `<button type="button" role="menuitemradio" data-weapon="${w}" aria-checked="${w === app.aim.weapon}">
          <span>${WEAPONS[w].name}</span><span class="count">${w === "baby_missile" ? "∞" : `×${p.inventory[w]}`}</span></button>`,
      )
      .join("") + `<div class="hint">Tab cycles weapons. Buy more in the shop between rounds.</div>`;
  const r = btn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 248))}px`;
  menu.style.top = `${r.bottom + 4}px`;
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  menu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
}

function closeWeaponMenu(): void {
  const menu = $("weapon-menu");
  if (menu.hidden) return;
  menu.hidden = true;
  $("hud-weapon-btn").setAttribute("aria-expanded", "false");
}

function aimFromPointer(e: PointerEvent): void {
  const tank = me()?.tank;
  if (!tank) return;
  const w = renderer.toWorld(e.clientX, e.clientY);
  const x0 = tank.x;
  const y0 = tank.y + TURRET_Y;
  const dx = w.x - x0;
  const dy = w.y - y0;
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle = dx >= 0 ? 0 : 180;
  const power = Math.round((Math.hypot(dx, dy) * 2.5) / 5) * 5;
  app.aimGuide = { x0, y0, x1: w.x, y1: w.y };
  setAim({ angle, power });
}

// ------------------------------------------------------------------ layout

function layoutStage(): void {
  const col = document.querySelector<HTMLElement>(".stage-col")!;
  // Keep the controls on screen: cap the map height to what's left of the viewport.
  const reserved = window.innerWidth <= 760 ? 300 : 250;
  const maxByHeight = ((window.innerHeight - reserved) * 16) / 9;
  col.style.maxWidth = `${Math.max(480, Math.round(maxByHeight))}px`;
  col.style.margin = "0 auto";
  col.style.width = "100%";
  renderer.resize($("stage").clientWidth || col.clientWidth);
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  window.addEventListener("resize", () => (shell.screen === "home" ? attract.resize() : layoutStage()));
  new ResizeObserver(() => shell.screen === "game" && renderer.resize($("stage").clientWidth)).observe($("stage"));
  // The map is only drawn when it changes, so draw it again for what the page did to it: names
  // drawn before their font arrived, a canvas the browser wiped.
  document.fonts.addEventListener("loadingdone", () => renderer.invalidate());
  renderer.canvas.addEventListener("contextrestored", () => renderer.invalidate());

  // Game controls
  $("ctl-angle").addEventListener("input", (e) => setAim({ angle: 180 - Number((e.target as HTMLInputElement).value) }));
  $("ctl-power").addEventListener("input", (e) => setAim({ power: Number((e.target as HTMLInputElement).value) }));
  $("ctl-weapon").addEventListener("change", (e) => setAim({ weapon: (e.target as HTMLSelectElement).value as WeaponId }));
  $("ctl-fire").addEventListener("click", fire);
  for (const btn of $$<HTMLButtonElement>("[data-step]")) {
    let repeat = 0;
    const step = (ev?: { shiftKey: boolean }) => {
      const field = btn.dataset.step as "angle" | "power";
      const delta = Number(btn.dataset.delta) * (ev?.shiftKey ? 5 : 1);
      setAim({ [field]: app.aim[field] + delta });
    };
    const stop = () => clearInterval(repeat);
    btn.addEventListener("pointerdown", (ev) => {
      step(ev);
      stop();
      const started = performance.now();
      repeat = window.setInterval(() => performance.now() - started > 350 && step(ev), 50);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) btn.addEventListener(ev, stop);
    btn.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        step(ev);
      }
    });
  }

  const canvas = renderer.canvas;
  canvas.addEventListener("pointerdown", (e) => {
    if (!isMyTurn() || app.firing) return;
    app.dragging = true;
    canvas.setPointerCapture(e.pointerId);
    aimFromPointer(e);
  });
  canvas.addEventListener("pointermove", (e) => app.dragging && aimFromPointer(e));
  for (const ev of ["pointerup", "pointercancel"]) {
    canvas.addEventListener(ev, () => {
      app.dragging = false;
      app.aimGuide = null;
    });
  }

  // Weapon picker in the HUD.
  const weaponMenu = $("weapon-menu");
  $("hud-weapon-btn").addEventListener("click", () => (weaponMenu.hidden ? openWeaponMenu() : closeWeaponMenu()));
  weaponMenu.addEventListener("click", (e) => {
    const weapon = (e.target as HTMLElement).closest<HTMLElement>("[data-weapon]")?.dataset.weapon;
    if (!weapon) return;
    setAim({ weapon: weapon as WeaponId });
    closeWeaponMenu();
    // Hand the keyboard back to the game so Space fires.
    (document.activeElement as HTMLElement | null)?.blur();
  });
  weaponMenu.addEventListener("keydown", (e) => {
    const items = Array.from(weaponMenu.querySelectorAll<HTMLElement>("button"));
    const i = items.indexOf(document.activeElement as HTMLElement);
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    items[(i + step + items.length) % items.length]?.focus();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!(e.target as HTMLElement).closest("#weapon-menu, #hud-weapon-btn")) closeWeaponMenu();
  });
  window.addEventListener("resize", closeWeaponMenu);

  // Mouse clicks on the steppers shouldn't keep focus, or Space would step instead of fire.
  for (const btn of $$("[data-step]")) btn.addEventListener("mousedown", (e) => e.preventDefault());

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeWeaponMenu();
    if (shell.screen !== "game" || !isMyTurn()) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, select, textarea, #weapon-menu")) return;
    // A focused button handles its own Space/Enter (Fire fires, the steppers step).
    if ((e.key === " " || e.key === "Enter") && target.closest("button")) return;
    const big = e.shiftKey;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => setAim({ angle: app.aim.angle + (big ? 5 : 1) }),
      ArrowRight: () => setAim({ angle: app.aim.angle - (big ? 5 : 1) }),
      ArrowUp: () => setAim({ power: app.aim.power + (big ? 50 : 10) }),
      ArrowDown: () => setAim({ power: app.aim.power - (big ? 50 : 10) }),
      PageUp: () => setAim({ power: app.aim.power + 100 }),
      PageDown: () => setAim({ power: app.aim.power - 100 }),
      Tab: () => cycleWeapon(e.shiftKey ? -1 : 1),
      " ": fire,
      Enter: fire,
    };
    const action = actions[e.key];
    if (!action) return;
    e.preventDefault();
    action();
  });

  // Shop & game over
  $("shop-grid").addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-buy], [data-sell]");
    if (!el) return;
    sfx.click();
    if (el.dataset.buy) shell.send({ t: "buy", item: el.dataset.buy as ShopId, qty: 1 });
    else shell.send({ t: "buy", item: el.dataset.sell as ShopId, qty: -1 });
  });
  $("shop-ready").addEventListener("click", () => shell.send({ t: "ready", ready: !me()?.ready }));
}

wire();
shell.start();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __cc: { app, renderer, shell } });
