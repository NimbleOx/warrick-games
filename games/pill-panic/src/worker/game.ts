import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState } from "@warrick/kit/worker/lobby";
import { COUNTDOWN_MS, INTERMISSION_MS, PLAYER_COLORS, TICK_MS, virusCount } from "../shared/constants";
import {
  DEFAULT_SETTINGS,
  SETTING_CHOICES,
  type ClientMsg,
  type GameState,
  type PlayerState,
  type RoundSnap,
  type ServerMsg,
  type Standing,
} from "../shared/protocol";
import { Round } from "../shared/round";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

/** The round being played. Its bottles change every tick, so it lives in memory only. */
export interface Live {
  round: Round;
  rng: Rng;
}

const CPU_NAMES = ["Pip", "Fizz", "Dose", "Tonic", "Zinc", "Syrup", "Tablet", "Placebo", "Remedy", "Lozenge"];

export function newGameState(code: string, now: number): GameState {
  return { ...baseState(code, now, DEFAULT_SETTINGS), match: 0, round: null, results: null };
}

/**
 * Pill Panic's rules on top of the kit's lobby: matches of several rounds, replaying players'
 * inputs, the loop (CPU bottles, deciding rounds) and the results.
 */
export class Game extends Lobby<GameState, ServerMsg, Live> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly colors = PLAYER_COLORS;
  protected readonly cpuNames = CPU_NAMES;

  protected createPlayer(base: BasePlayer): PlayerState {
    return { ...base, slot: -1, wins: 0, cleared: 0, sent: 0, trophies: 0 };
  }

  bySlot(slot: number): PlayerState | undefined {
    return slot < 0 ? undefined : this.s.players.find((p) => p.slot === slot);
  }

  /** Someone arriving mid-match is told they play from the next round. */
  addHuman(rawName: string): PlayerState {
    const p = super.addHuman(rawName);
    const joined = this.logs.at(-1);
    if (joined && !p.spectator && this.s.phase === "playing") joined.text += ", and plays from the next round";
    return p;
  }

  /** A player who arrives mid-match gets a seat, and plays from the next round. */
  protected joinMidGame(): boolean {
    return true;
  }

  /** A player left mid-round: their bottle tops out. */
  leave(id: string): void {
    const p = this.player(id);
    if (p && p.slot >= 0 && !this.s.round?.over) this.live?.round.quit(p.slot);
    super.leave(id);
  }

  protected requireBetweenRounds(): void {
    if (!this.betweenRounds()) throw new GameError("Wait for the match to end");
  }

  // ---------------------------------------------------------------- match flow

  /** Start a match, from the lobby or from the last match's results. */
  start(byId: string): void {
    this.beginStart(byId);
    this.s.match++;
    for (const p of this.s.players) {
      p.wins = 0;
      p.cleared = 0;
      p.sent = 0;
    }
    this.s.results = null;
    const { level, speed, wins } = this.s.settings;
    this.event(
      `Match ${this.s.match}: level ${level} (${virusCount(level)} germs), ${speed} speed, first to ${wins} round${wins === 1 ? "" : "s"}`,
    );
    this.startRound(1);
  }

  protected resetForLobby(): void {
    this.s.results = null;
    this.s.round = null;
  }

  /** The room restarted and the round's bottles were lost: play it again. */
  recover(): void {
    const r = this.s.round;
    if (this.s.phase !== "playing" || this.live || !r) return;
    if (r.over) {
      this.startRound(r.n + 1);
      return;
    }
    this.event(`The server restarted, so round ${r.n} starts over`);
    this.startRound(r.n);
  }

  /** The loop is starting again after nobody was here: pick the round up where it stopped. */
  resume(): void {
    const r = this.s.round;
    if (this.s.phase !== "playing" || !this.live || !r || r.over) return;
    const now = this.io.now();
    const max = this.live.round.maxTick();
    if (Math.floor((now - r.goAt) / TICK_MS) > max + 30) {
      r.goAt = now - max * TICK_MS;
      this.touch();
    }
  }

  /** A player's inputs. */
  feed(id: string, msg: Extract<ClientMsg, { t: "in" }>): void {
    const p = this.player(id);
    const r = this.s.round;
    if (!p || p.slot < 0 || !this.live || !r || r.over) return;
    this.live.round.feed(p.slot, msg.e, msg.n, msg.k, msg.g, this.wall());
  }

  /** The player's browser lost track of its own bottle: send it ours with the next frame. */
  resyncOwn(id: string): void {
    const p = this.player(id);
    if (p && p.slot >= 0 && !this.s.round?.over) this.live?.round.resync(p.slot);
  }

  /** A browser (re)connected: its bottle starts over from the server's copy. */
  rejoin(id: string): void {
    const p = this.player(id);
    if (p && p.slot >= 0 && !this.s.round?.over) this.live?.round.rejoin(p.slot);
  }

  snapshot(): RoundSnap | null {
    const r = this.s.round;
    return this.live && r ? this.live.round.snapshot(r.n, r.goAt, this.who()) : null;
  }

  /** Player id by slot, for the round's snapshot. */
  private who(): (string | null)[] {
    const who: (string | null)[] = Array(MAX_PLAYERS).fill(null);
    for (const p of this.s.players) if (p.slot >= 0) who[p.slot] = p.id;
    return who;
  }

  /** Run the round: called by the room's loop. */
  tick(): void {
    const s = this.s;
    const r = s.round;
    if (s.phase !== "playing" || !r) return;
    if (r.over) {
      if (r.nextAt !== null && this.io.now() >= r.nextAt) this.startRound(r.n + 1);
      return;
    }
    const live = this.live;
    if (!live) return;
    live.round.step(this.wall(), (slot) => {
      const p = this.bySlot(slot);
      return !!p && (!!p.cpu || this.io.isConnected(p.id));
    });
    const frame = live.round.collect();
    if (frame) this.outbox.push(frame);
    if (live.round.outcome) this.finishRound();
  }

  private wall(): number {
    const r = this.s.round;
    return r ? Math.floor((this.io.now() - r.goAt) / TICK_MS) : -1;
  }

  private startRound(n: number): void {
    const s = this.s;
    this.promoteSpectators();
    for (const p of s.players) p.slot = -1;
    // Players who are offline sit this round out.
    const seated = this.participants.filter((p) => p.cpu || p.connected);
    if (seated.length < 2) return this.endMatch(null, "Not enough players left to carry on.");
    seated.forEach((p, i) => (p.slot = i));
    // Its own stream, apart from the seed everyone sees, so the seed doesn't give away where
    // attacks will land or how the CPUs will play.
    const rng = mulberry32(randomSeed());
    const seed = randomSeed();
    const { level, speed, aim } = s.settings;
    const round = new Round({ seed, level, speed, aim, seats: seated.map((p) => ({ slot: p.slot, cpu: p.cpu })) }, rng);
    this.live = { round, rng };
    s.phase = "playing";
    s.round = { n, seed, goAt: this.io.now() + COUNTDOWN_MS, level, speed, over: null, nextAt: null };
    this.outbox.push({ t: "snap", snap: round.snapshot(n, s.round.goAt, this.who()) });
    this.touch();
  }

  private finishRound(): void {
    const s = this.s;
    const r = s.round!;
    const round = this.live!.round;
    const o = round.outcome!;
    // Let the last frame show how the round ended.
    const frame = round.collect();
    if (frame) this.outbox.push(frame);

    const seated = s.players.filter((p) => p.slot >= 0);
    const winners = o.winners.map((slot) => this.bySlot(slot)).filter((p): p is PlayerState => !!p);
    for (const w of winners) w.wins++;
    const stats = seated.map((p) => {
      const st = round.stats(p.slot)!;
      p.cleared += st.cleared;
      p.sent += st.sent;
      return { id: p.id, ...st };
    });
    r.over = { winners: winners.map((p) => p.id), how: winners.length ? o.how : "draw", stats };

    const names = winners.map((p) => p.name).join(" and ");
    if (!winners.length) this.event(`Round ${r.n} is a draw`);
    else if (o.how === "cleared") this.event(`${names} cleared the bottle first and ${winners.length > 1 ? "share" : "takes"} round ${r.n}`);
    else this.event(`${names} is the last one standing and takes round ${r.n}`);

    // The match goes to the first to the target, as long as nobody is level with them.
    const target = s.settings.wins;
    const ranked = [...this.participants].sort((a, b) => b.wins - a.wins);
    const [top, second] = ranked;
    if (top && top.wins >= target && (!second || top.wins > second.wins)) {
      this.endMatch(top, "");
    } else {
      r.nextAt = this.io.now() + INTERMISSION_MS;
      this.touch();
    }
  }

  private endMatch(winner: PlayerState | null, note: string): void {
    const s = this.s;
    const standings: Standing[] = this.participants
      .map((p) => ({ id: p.id, name: p.name, color: p.color, cpu: !!p.cpu, wins: p.wins, cleared: p.cleared, sent: p.sent }))
      .sort((a, b) => b.wins - a.wins || b.cleared - a.cleared || b.sent - a.sent);
    s.results = { match: s.match, winnerId: winner?.id ?? null, rounds: s.round?.n ?? 0, note, standings };
    s.phase = "results";
    if (s.round && !s.round.over) s.round = null;
    if (winner) {
      winner.trophies++;
      this.event(`${winner.name} wins the match!`);
    } else if (note) {
      this.event(note);
    }
    for (const p of s.players) p.slot = -1;
    this.live = null;
    this.touch();
  }
}
