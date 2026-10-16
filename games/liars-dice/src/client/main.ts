import { unlockAudio } from "@warrick/kit/client/audio";
import { $, $$, esc, toast } from "@warrick/kit/client/dom";
import { Shell, type Screen } from "@warrick/kit/client/shell";
import { REVEAL_COUNT_START_MS, REVEAL_LIFT_MS, REVEAL_PER_DIE_MS } from "../shared/constants";
import {
  SETTING_CHOICES,
  rankPlayers,
  type Bid,
  type ClientMsg,
  type GameState,
  type PlayerState,
  type Reveal,
  type ServerMsg,
} from "../shared/protocol";
import { FACES, bidError, bidText, counts, minQty, type RoundRules } from "../shared/rules";
import { Attract } from "./attract";
import { sfx } from "./audio";
import { dieSvg, hiddenDie } from "./dice";
import { Pending } from "./pending";

// ------------------------------------------------------------------ app state

const app = {
  /** My own cup, as the server last sent it. Only shown for its round. */
  hand: null as { round: number; dice: number[] } | null,
  /** The bid picker. */
  qty: 1,
  face: null as number | null,
  /** Which turn the picker was last set up for. */
  turnKey: "",
  /** The reveal being animated, and how far its count has got (for the ticks). */
  revealKey: "",
  revealShown: -1,
  revealDone: false,
  /** Bids already heard (for the click). */
  bidsHeard: "",
  gameoverClosed: false,
};

/** A move on its way to the server. */
const move = new Pending(6000, () => {
  if (shell.state) renderPicker(shell.state);
  toast("The server didn't answer — try again");
});

const shell: Shell<GameState, ClientMsg, ServerMsg> = new Shell({
  slug: "liars-dice",
  title: "Liar's Dice",
  prefix: "ld",
  logo: "LIAR'S<br />DICE",
  tagline: "Bluff your friends, one bid at a time.<br />No accounts — just share a code.",
  placeholder: "El Bluffo",
  footer: "After <em>Perudo</em>, the dice game of the Andes.",
  rules: [
    "Everyone rolls 5 dice in secret. Bid on how many of one face are on the <b>whole table</b>.",
    "Each bid raises the last: more dice, or the same number of a higher face.",
    "Don't believe it? Call <b>Liar!</b> Whoever's wrong loses a die. The last player with dice wins.",
    "Wild ones count as every face. Switching to ones halves the bid; switching back doubles it, plus one.",
  ],
  settings: {
    wild: { label: "Ones", fmt: (v: boolean) => (v ? "Wild" : "Not wild") },
    spotOn: { label: "Spot on", fmt: (v: boolean) => (v ? "Allowed" : "Off") },
    turnSeconds: { label: "Turn timer", fmt: (v: number) => (v ? `${v} seconds` : "No limit") },
  },
  choices: SETTING_CHOICES,
  onWelcome: () => {
    move.answered();
    app.turnKey = "";
  },
  onMessage,
  onState,
  onScreen,
  onReset,
  confirmLeave: (s): string | null => {
    const p = me(s);
    if ((s.phase === "playing" || s.phase === "reveal") && p && !p.spectator && !p.out) return "Leave this game? You'll be out.";
    return null;
  },
});
const attract = new Attract($<HTMLCanvasElement>("attract"));

const me = (s = shell.state): PlayerState | undefined => s?.players.find((p) => p.id === shell.me);
const player = (id: string | null | undefined) => shell.player(id);
const rulesOf = (s: GameState): RoundRules => ({ wild: s.settings.wild });
const tableDice = (s: GameState) => s.players.reduce((n, p) => n + p.dice, 0);
const isMyTurn = (s = shell.state) => !!s && s.phase === "playing" && s.turnId === shell.me;
/** My cup this round, once the server has sent it. */
const myDice = (s = shell.state): number[] | null => (s && app.hand?.round === s.round ? app.hand.dice : null);

function nameOf(id: string | null | undefined, you = "You"): string {
  if (id === shell.me) return you;
  return esc(player(id)?.name ?? "?");
}

function chip(p: PlayerState | undefined): string {
  return p ? `<span class="chip" style="background:${p.color}"></span>` : "";
}

/** "seven" and a die: how a bid looks on the table. */
function bidHtml(bid: Bid, cls = ""): string {
  return `<span class="bid ${cls}"><b>${bid.qty}</b><span class="times">×</span>${dieSvg(bid.face)}</span>`;
}

// ------------------------------------------------------------------ shell hooks

function onScreen(screen: Screen): void {
  if (screen !== "game") $("gameover").hidden = true;
}

function onReset(): void {
  app.hand = null;
  app.turnKey = "";
  app.revealKey = "";
  move.answered();
  app.gameoverClosed = false;
  $("gameover").hidden = true;
}

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case "hand":
      app.hand = { round: msg.round, dice: msg.dice };
      sfx.roll();
      if (shell.state && shell.state.phase !== "lobby") renderGame(shell.state);
      break;
    case "error":
      // The shell has shown the message.
      move.answered();
      if (shell.state) renderPicker(shell.state);
      break;
  }
}

function onState(s: GameState, prev: GameState | null): void {
  move.answered();
  if (s.phase === "lobby") {
    app.gameoverClosed = false;
    return;
  }
  if (prev?.phase !== "gameover" && s.phase === "gameover") {
    app.gameoverClosed = false;
    if (s.winnerId === shell.me) sfx.win();
  }

  // A new turn of mine: set the picker up at the smallest raise on the current face.
  const key = `${s.round}:${s.bids.length}:${s.turnId}`;
  if (isMyTurn(s) && key !== app.turnKey) {
    app.turnKey = key;
    const last = s.bids.at(-1) ?? null;
    const total = tableDice(s);
    app.qty = last
      ? (minQty(last, last.face, rulesOf(s), total) ?? Math.min(total, last.qty))
      : Math.max(1, Math.round(total / 6));
    app.face = null;
    sfx.turn();
  }

  // Somebody else bid.
  const heard = `${s.round}:${s.bids.length}`;
  if (heard !== app.bidsHeard) {
    if (s.bids.length && s.bids.at(-1)!.by !== shell.me && app.bidsHeard) sfx.bid();
    app.bidsHeard = heard;
  }

  document.title = isMyTurn(s) ? "▶ Your turn — Liar's Dice" : `Liar's Dice · ${s.code}`;
  renderGame(s);
}

// ------------------------------------------------------------------ rendering

function renderGame(s: GameState): void {
  renderStatus(s);
  renderSeats(s);
  renderBidbox(s);
  renderCup(s);
  renderPicker(s);
  renderHistory(s);
  renderGameOver(s);
  animateReveal(performance.now());
}

function renderStatus(s: GameState): void {
  // While the cups are up, the count is of the dice on show (before anyone lost one).
  const r = shownReveal(s);
  const n = r ? r.hands.reduce((a, h) => a + h.dice.length, 0) : tableDice(s);
  $("status-round").innerHTML = s.round ? `Round <b>${s.round}</b> · <b>${n}</b> dice on the table` : "";
  const chips = [s.settings.wild ? "Ones wild" : "Ones not wild", s.settings.spotOn ? "Spot on" : ""].filter(Boolean);
  $("status-rules").innerHTML = chips.map((c) => `<span class="tag">${c}</span>`).join("");
}

/** The reveal on screen right now: during the reveal phase, and kept on the table at game over. */
function shownReveal(s: GameState): Reveal | null {
  const r = s.reveal;
  if (!r) return null;
  if (s.phase === "reveal" || (s.phase === "gameover" && r.round === s.round)) return r;
  return null;
}

function renderSeats(s: GameState): void {
  const r = shownReveal(s);
  const rules = r ? { wild: r.wild } : rulesOf(s);
  const lastBid = new Map<string, Bid>();
  for (const b of s.bids) lastBid.set(b.by, b);
  let k = 0;
  const html = s.order
    .map((id) => {
      const p = player(id);
      if (!p) return "";
      const you = id === shell.me;
      const turn = s.phase === "playing" && s.turnId === id;
      let dice = "";
      if (r) {
        const cup = r.hands.find((h) => h.id === id)?.dice ?? [];
        dice = cup
          .map((d) => {
            const counted = counts(d, r.bid.face, rules);
            const wild = counted && d !== r.bid.face;
            return dieSvg(d, `${counted ? "counted" : "uncounted"} ${wild ? "wild" : ""}`, counted ? `data-k="${k++}"` : "");
          })
          .join("");
      } else if (you && myDice(s)) {
        dice = myDice(s)!
          .map((d) => dieSvg(d, "mine"))
          .join("");
      } else {
        dice = Array.from({ length: p.dice }, () => hiddenDie()).join("");
      }
      let note = "";
      if (r && id === r.callerId)
        note = r.kind === "liar" ? `<span class="call">Liar!</span>` : `<span class="call spot">Spot on!</span>`;
      else if (lastBid.has(id) && s.phase !== "gameover") note = bidHtml(lastBid.get(id)!, "small");
      else if (turn) note = `<span class="muted">${p.cpu ? "thinking…" : you ? "your turn" : "deciding…"}</span>`;
      if (p.out && !(r && r.hands.some((h) => h.id === id)))
        note = `<span class="muted">${p.place === null ? "out" : `out · #${p.place}`}</span>`;
      const cls = [
        "seat",
        turn ? "turn" : "",
        p.out && !(r && r.hands.some((h) => h.id === id)) ? "out" : "",
        you ? "me" : "",
        !p.cpu && !p.connected ? "offline" : "",
        r?.loserId === id ? "loser" : "",
        r?.gainerId === id ? "gainer" : "",
        s.winnerId === id ? "winner" : "",
      ].join(" ");
      const tags = [
        you ? `<span class="tag tag-you">you</span>` : "",
        p.cpu ? `<span class="tag">CPU</span>` : "",
        !p.cpu && !p.connected ? `<span class="tag">offline</span>` : "",
        s.winnerId === id ? `<span class="tag tag-host">winner</span>` : "",
      ].join("");
      return `<li class="${cls}" style="--pc:${p.color}" data-id="${id}">
        <div class="seat-head">${chip(p)}<span class="pname">${esc(p.name)}</span>${tags}<span class="spacer"></span><span class="seat-clock"></span></div>
        <div class="seat-dice">${dice || `<span class="muted small">no dice</span>`}</div>
        <div class="seat-note">${note}</div>
      </li>`;
    })
    .join("");
  const watching = s.players.filter((p) => p.spectator);
  const extra = watching.length ? `<li class="watchers muted">Watching: ${watching.map((p) => esc(p.name)).join(", ")}</li>` : "";
  $("seats").innerHTML = html + extra;
  $("seats").dataset.count = String(Math.min(8, s.order.length));
}

function renderBidbox(s: GameState): void {
  const box = $("bidbox");
  const r = shownReveal(s);
  const last = s.bids.at(-1);
  let html = "";
  if (r) {
    const bidder = nameOf(r.bidderId, "your");
    const whose = r.bidderId === shell.me ? "your" : `${bidder}'s`;
    const what = r.kind === "liar" ? "Liar!" : "Spot on!";
    html = `<div class="bid-by">${chip(player(r.callerId))}${nameOf(r.callerId)} called <b>${what}</b> on ${whose}</div>
      ${bidHtml(r.bid, "big")}
      <div class="count-line">Counting ${r.bid.face}s${r.wild && r.bid.face !== 1 ? " and wild 1s" : ""}: <b class="count" id="reveal-count">0</b></div>
      <div class="result" id="reveal-result">${resultText(r)}${s.phase === "gameover" ? ` ${winnerText(s)} <button class="btn btn-small" id="show-results">Results</button>` : ""}</div>`;
  } else if (s.phase === "playing") {
    const turn = player(s.turnId);
    const mine = isMyTurn(s);
    if (last) {
      html = `<div class="bid-by">${chip(player(last.by))}${nameOf(last.by)} bid</div>${bidHtml(last, "big")}
        <div class="bid-note">${mine ? "<b>Your turn:</b> raise it or call Liar!" : `${chip(turn)}${esc(turn?.name ?? "")}'s turn`}</div>`;
    } else {
      html = `<div class="bid-by">A fresh round</div><div class="bid-empty">No bids yet</div>
        <div class="bid-note">${mine ? "<b>Your turn:</b> open the bidding" : `${chip(turn)}${esc(turn?.name ?? "")} opens the bidding`}</div>`;
    }
  } else if (s.phase === "gameover") {
    html = `<div class="bid-by">Game over</div><div class="bid-empty">${winnerText(s)}</div>
      <div class="bid-note"><button class="btn btn-small" id="show-results">Results</button></div>`;
  }
  if (box.dataset.html !== html) {
    box.innerHTML = html;
    box.dataset.html = html;
  }
  box.classList.toggle("revealing", !!r);
}

function winnerText(s: GameState): string {
  const w = player(s.winnerId);
  if (!w) return "Nobody's left.";
  return `${chip(w)}<b>${s.winnerId === shell.me ? "You win!" : `${esc(w.name)} wins!`}</b>`;
}

function resultText(r: Reveal): string {
  const there = `There ${r.count === 1 ? "was" : "were"} <b>${r.count}</b>.`;
  const you = (id: string | null) => id === shell.me;
  const loses = `<b>${nameOf(r.loserId, "you")}</b> ${you(r.loserId) ? "lose" : "loses"} a die${r.outId ? (you(r.outId) ? " and are out" : " and is out") : ""}.`;
  if (r.kind === "liar") return `${there} ${r.loserId === r.callerId ? "The bid stands" : "Caught bluffing"}: ${loses}`;
  if (!r.loserId)
    return `${there} Spot on! ${r.gainerId ? `<b>${nameOf(r.gainerId, "You")}</b> ${you(r.gainerId) ? "get" : "gets"} a die back.` : "Already at five dice."}`;
  return `${there} Not quite: ${loses}`;
}

function renderCup(s: GameState): void {
  const p = me(s);
  const cup = $("cup");
  const waiting = $("waiting");
  const seated = !!p && !p.spectator && s.order.includes(p.id);
  const inGame = seated && !p!.out;
  cup.hidden = !inGame || s.phase === "gameover";
  waiting.hidden = inGame || s.phase === "gameover";
  if (!seated) waiting.textContent = "You're watching this game. You'll get a seat when the host starts the next one.";
  else if (p!.out) waiting.textContent = "You're out of dice. Stick around to see who wins.";
  if (cup.hidden) return;
  const r = shownReveal(s);
  const dice = myDice(s);
  let html: string;
  if (r && r.hands.some((h) => h.id === shell.me)) {
    const mine = r.hands.find((h) => h.id === shell.me)!.dice;
    html = mine.map((d) => dieSvg(d, counts(d, r.bid.face, { wild: r.wild }) ? "counted lit" : "uncounted")).join("");
  } else if (dice) {
    html = dice.map((d) => dieSvg(d)).join("");
  } else {
    html = Array.from({ length: p!.dice }, () => hiddenDie("rolling")).join("");
  }
  const el = $("my-dice");
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
}

function renderPicker(s: GameState): void {
  const p = me(s);
  const picker = $("picker");
  const inGame = !!p && !p.spectator && !p.out && s.order.includes(p.id);
  picker.hidden = !inGame || s.phase === "gameover";
  if (picker.hidden) return;

  const mine = isMyTurn(s) && !move.waiting;
  const rules = rulesOf(s);
  const total = tableDice(s);
  const last = s.bids.at(-1) ?? null;
  app.qty = Math.min(Math.max(1, app.qty), Math.max(1, total));
  if (app.face !== null && bidError(last, { qty: app.qty, face: app.face }, rules, total)) app.face = null;

  $("qty").textContent = String(app.qty);
  $<HTMLButtonElement>("qty-down").disabled = !mine || app.qty <= 1;
  $<HTMLButtonElement>("qty-up").disabled = !mine || app.qty >= total;

  const faces = FACES.map((f) => {
    const legal = mine && !bidError(last, { qty: app.qty, face: f }, rules, total);
    const min = minQty(last, f, rules, total);
    const hint = min === null ? (last ? "—" : "no") : `≥${min}`;
    const title =
      min === null ? (last ? "No higher bid on this face" : "Ones are wild: you can't open on them") : `At least ${min}`;
    return `<button class="face" data-face="${f}" aria-pressed="${app.face === f}" ${legal ? "" : "disabled"} title="${title}">
      ${dieSvg(f)}<span class="min">${hint}</span></button>`;
  }).join("");
  const facesEl = $("faces");
  if (facesEl.dataset.html !== faces) {
    facesEl.innerHTML = faces;
    facesEl.dataset.html = faces;
  }

  const bidBtn = $<HTMLButtonElement>("bid-btn");
  const chosen = app.face !== null ? { qty: app.qty, face: app.face } : null;
  bidBtn.disabled = !mine || !chosen;
  bidBtn.textContent = chosen ? `Bid ${bidText(chosen)}` : "Bid";
  $<HTMLButtonElement>("liar-btn").disabled = !mine || !last;
  const spot = $<HTMLButtonElement>("spot-btn");
  spot.hidden = !s.settings.spotOn;
  spot.disabled = !mine || !last;
  picker.classList.toggle("active", mine);

  const turn = player(s.turnId);
  let why = "";
  if (s.phase === "reveal") why = "The cups are up…";
  else if (move.waiting) why = "Sending…";
  else if (!isMyTurn(s)) why = turn ? `Waiting for ${esc(turn.name)}…` : "";
  else if (!chosen)
    why = last
      ? `Pick a quantity and a face that raise ${bidText(last)}, or call Liar!`
      : "Open the bidding: pick a quantity and a face.";
  const whyEl = $("why");
  if (whyEl.innerHTML !== why) whyEl.innerHTML = why;
}

function renderHistory(s: GameState): void {
  const r = shownReveal(s);
  const rows = s.bids.map(
    (b) =>
      `<li>${chip(player(b.by))}<span class="who">${nameOf(b.by)}</span><span class="spacer"></span>${bidHtml(b, "small")}</li>`,
  );
  if (r)
    rows.push(
      `<li class="call-row">${chip(player(r.callerId))}<span class="who">${nameOf(r.callerId)}</span><span class="spacer"></span><b>${r.kind === "liar" ? "Liar!" : "Spot on!"}</b></li>`,
    );
  const html = rows.length ? rows.join("") : `<li class="muted">No bids yet.</li>`;
  const ol = $("history");
  if (ol.dataset.html !== html) {
    ol.innerHTML = html;
    ol.dataset.html = html;
    ol.scrollTop = ol.scrollHeight;
  }
  // Once the next round is on, a line about the last call.
  const prev = s.reveal && !r ? s.reveal : null;
  const lastCall = $("last-call");
  lastCall.hidden = !prev;
  if (prev) {
    const whose = prev.bidderId === shell.me ? "your" : `${nameOf(prev.bidderId)}'s`;
    lastCall.innerHTML = `Last round, ${nameOf(prev.callerId, "you")} called ${prev.kind === "liar" ? "Liar!" : "Spot on"} on ${whose} ${bidText(prev.bid)}. ${resultText(prev)}`;
  }
}

function renderGameOver(s: GameState): void {
  const open = s.phase === "gameover" && !app.gameoverClosed && revealFinished(s);
  $("gameover").hidden = !open;
  if (!open) return;
  const ranked = s.players.filter((p) => !p.spectator && s.order.includes(p.id)).sort(rankPlayers);
  const w = player(s.winnerId);
  $("gameover-winner").innerHTML = w
    ? `<b style="color:${w.color}">${esc(w.name)}</b> ${s.winnerId === shell.me ? "(you!) " : ""}outlasted the table in ${s.round} rounds.`
    : "";
  const spot = s.settings.spotOn;
  $("gameover-spot-head").hidden = !spot;
  $("gameover-rows").innerHTML = ranked
    .map(
      (p) => `<tr class="${p.id === s.winnerId ? "winner" : ""}">
        <td>${p.place ?? ""}</td>
        <td><span class="pcell">${chip(p)}${esc(p.name)}${p.id === shell.me ? ` <span class="tag tag-you">you</span>` : ""}</span></td>
        <td>${p.id === s.winnerId ? "—" : p.outRound ? `round ${p.outRound}` : "—"}</td>
        <td>${p.callsWon}/${p.calls}</td>
        ${spot ? `<td>${p.spotsWon}/${p.spots}</td>` : ""}</tr>`,
    )
    .join("");
  const back = $<HTMLButtonElement>("gameover-lobby");
  const host = shell.canHost(s);
  back.disabled = !host;
  back.textContent = host ? "Back to lobby" : `Waiting for ${player(s.hostId)?.name ?? "the host"}…`;
}

// ------------------------------------------------------------------ the reveal

function revealElapsed(r: Reveal): number {
  return shell.serverNow() - r.at;
}

function revealEnd(r: Reveal): number {
  return REVEAL_COUNT_START_MS + r.count * REVEAL_PER_DIE_MS + 250;
}

/** The count has finished (or there's nothing to count). */
function revealFinished(s: GameState): boolean {
  const r = shownReveal(s);
  return !r || revealElapsed(r) >= revealEnd(r);
}

/** Runs every frame: lift the cups, light up the counted dice one at a time, then show the result. */
function animateReveal(_now: number): void {
  const s = shell.state;
  if (!s || shell.screen !== "game") return;
  const r = shownReveal(s);
  const seats = $("seats");
  if (!r) {
    seats.classList.remove("lifted", "counting", "settled");
    return;
  }
  const key = `${r.round}:${r.at}`;
  const t = revealElapsed(r);
  if (key !== app.revealKey) {
    app.revealKey = key;
    app.revealShown = -1;
    app.revealDone = false;
    // Only make noise for a call that's just happened, not one we arrived in the middle of.
    if (t < 1500) sfx.call();
  }
  seats.classList.toggle("lifted", t >= REVEAL_LIFT_MS * 0.3);
  seats.classList.toggle("counting", t >= REVEAL_COUNT_START_MS);
  const shown =
    t < REVEAL_COUNT_START_MS ? 0 : Math.min(r.count, Math.floor((t - REVEAL_COUNT_START_MS) / REVEAL_PER_DIE_MS) + 1);
  for (const el of $$<HTMLElement>("#seats [data-k]")) el.classList.toggle("lit", Number(el.dataset.k) < shown);
  const countEl = document.getElementById("reveal-count");
  if (countEl && countEl.textContent !== String(shown)) countEl.textContent = String(shown);
  if (shown > app.revealShown) {
    if (app.revealShown >= 0 && t < revealEnd(r) + 500) sfx.tick(shown);
    app.revealShown = shown;
  }
  const done = t >= revealEnd(r);
  document.getElementById("reveal-result")?.classList.toggle("shown", done);
  seats.classList.toggle("settled", done);
  if (done && !app.revealDone) {
    app.revealDone = true;
    if (t < revealEnd(r) + 800) {
      if (r.loserId === shell.me) sfx.lose();
      else if (r.gainerId === shell.me) sfx.gain();
    }
    if (s.phase === "gameover") renderGameOver(s);
  }
}

// ------------------------------------------------------------------ clocks and frames

function tickClocks(): void {
  const s = shell.state;
  if (!s) return;
  const left = s.phase === "playing" && s.turnDeadline ? Math.max(0, s.turnDeadline - shell.serverNow()) : null;
  const text = left === null ? "" : `${Math.ceil(left / 1000)}s`;
  const clock = $("clock");
  if (clock.textContent !== text) clock.textContent = text;
  clock.classList.toggle("low", left !== null && left < 6000);
  const seatClock = document.querySelector<HTMLElement>("#seats .turn .seat-clock");
  if (seatClock && seatClock.textContent !== text) seatClock.textContent = text;
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (shell.screen === "home") {
    attract.frame(now);
    return;
  }
  if (shell.screen !== "game") return;
  animateReveal(now);
  tickClocks();
}

// ------------------------------------------------------------------ moves

function send(msg: ClientMsg): void {
  const s = shell.state;
  if (!s || !isMyTurn(s) || move.waiting) return;
  unlockAudio();
  if (!shell.send(msg)) {
    toast("Not connected — reconnecting, try again in a moment");
    return;
  }
  move.start();
  renderPicker(s);
}

function placeBid(): void {
  if (app.face === null) return;
  sfx.click();
  send({ t: "bid", qty: app.qty, face: app.face });
}

function stepQty(delta: number): void {
  const s = shell.state;
  if (!s || !isMyTurn(s)) return;
  app.qty = Math.min(tableDice(s), Math.max(1, app.qty + delta));
  renderPicker(s);
}

function pickFace(face: number): void {
  const s = shell.state;
  if (!s || !isMyTurn(s)) return;
  const err = bidError(s.bids.at(-1) ?? null, { qty: app.qty, face }, rulesOf(s), tableDice(s));
  if (err) {
    toast(err, "info");
    return;
  }
  app.face = app.face === face ? null : face;
  sfx.click();
  renderPicker(s);
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  $("qty-down").addEventListener("click", () => stepQty(-1));
  $("qty-up").addEventListener("click", () => stepQty(1));
  $("faces").addEventListener("click", (e) => {
    const f = (e.target as HTMLElement).closest<HTMLElement>("[data-face]")?.dataset.face;
    if (f) pickFace(Number(f));
  });
  $("bid-btn").addEventListener("click", placeBid);
  $("liar-btn").addEventListener("click", () => send({ t: "liar" }));
  $("spot-btn").addEventListener("click", () => send({ t: "spot" }));
  $("bidbox").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("#show-results")) {
      app.gameoverClosed = false;
      if (shell.state) renderGameOver(shell.state);
    }
  });
  $("gameover-close").addEventListener("click", () => {
    app.gameoverClosed = true;
    $("gameover").hidden = true;
  });

  // Clicking a game button shouldn't leave it focused, or Enter would press it again.
  for (const el of $$("#picker button")) el.addEventListener("mousedown", (e) => e.preventDefault());
  $("faces").addEventListener("mousedown", (e) => e.preventDefault());

  window.addEventListener("keydown", (e) => {
    if (shell.screen !== "game" || !isMyTurn() || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, select, textarea")) return;
    // A focused button handles its own Space/Enter.
    if ((e.key === " " || e.key === "Enter") && target.closest("button")) return;
    const key = e.key.toLowerCase();
    if (/^[1-6]$/.test(key)) pickFace(Number(key));
    else if (key === "arrowup" || key === "+" || key === "=") stepQty(1);
    else if (key === "arrowdown" || key === "-") stepQty(-1);
    else if (key === "enter") placeBid();
    else if (key === "l") send({ t: "liar" });
    else if (key === "s" && shell.state?.settings.spotOn) send({ t: "spot" });
    else return;
    e.preventDefault();
  });
}

wire();
shell.start();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { __ld: { app, move, shell, animateReveal, renderGame } });
