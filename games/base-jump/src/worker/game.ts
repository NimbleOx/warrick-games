import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState } from "@warrick/kit/worker/lobby";
import { newBrain, think, type Brain } from "../shared/ai";
import { Battle, wantsChecksum, type Cmd, type Frame } from "../shared/battle";
import { COUNTDOWN_TICKS, PLAYER_COLORS, SEND_PCTS, TICKS_PER_SEC, type SendPct } from "../shared/constants";
import { generateMap } from "../shared/map";
import {
  DEFAULT_SETTINGS,
  SETTING_CHOICES,
  type GameState,
  type PlayerState,
  type RoundResult,
  type ServerMsg,
  type Snapshot,
  type Standing,
} from "../shared/protocol";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

/** The round being played. It changes every tick, so it lives in memory only. */
export interface Live {
  battle: Battle;
  /** CPU memory, by slot. */
  brains: (Brain | null)[];
  rng: Rng;
  /** Players' commands, checked when they arrived and applied at the start of the next tick. */
  queue: Cmd[];
}

export function newGameState(code: string, now: number): GameState {
  return { ...baseState(code, now, DEFAULT_SETTINGS), round: 0, results: null };
}

/**
 * Base Jump's rules on top of the kit's lobby: starting rounds, players' commands, the tick
 * (CPUs, then the battle) and the results.
 */
export class Game extends Lobby<GameState, ServerMsg, Live> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly colors = PLAYER_COLORS;

  protected createPlayer(base: BasePlayer): PlayerState {
    return { ...base, slot: -1, wins: 0 };
  }

  /** A player left mid-round: their bases go neutral. */
  leave(id: string): void {
    const p = this.player(id);
    if (p && p.slot >= 0) this.live?.battle.leave(p.slot);
    super.leave(id);
  }

  /** Start a round, from the lobby or from the last round's results. */
  start(byId: string): void {
    this.beginStart(byId);
    this.s.round++;
    this.participants.forEach((p, i) => (p.slot = i));
    this.startRound();
    const mins = this.s.settings.minutes;
    const limit = mins ? `${mins} minutes on the clock` : "no time limit";
    this.event(`Round ${this.s.round}: ${this.live!.battle.bases.length} bases, ${limit}. Go!`);
  }

  protected resetForLobby(): void {
    this.s.results = null;
  }

  /** The room restarted mid-round and the battle was lost: play the round again on a new map. */
  recover(): void {
    if (this.s.phase !== "playing" || this.live) return;
    this.event(`The server restarted, so round ${this.s.round} starts over`);
    this.startRound();
  }

  snapshot(): Snapshot | null {
    return this.live?.battle.snapshot() ?? null;
  }

  /** Send units. Checked now, so a mistake comes straight back; carried out on the next tick. */
  send(id: string, from: unknown, to: unknown, pct: unknown): void {
    const slot = this.slotOf(id);
    const list = Array.isArray(from) ? from.filter((b): b is number => Number.isInteger(b)).slice(0, 80) : [];
    if (!Number.isInteger(to) || !SEND_PCTS.includes(pct as SendPct)) throw new GameError("That's not a move");
    this.queue(["s", slot, list, to as number, pct as SendPct]);
  }

  upgrade(id: string, b: unknown): void {
    const slot = this.slotOf(id);
    if (!Number.isInteger(b)) throw new GameError("That's not a base");
    this.queue(["u", slot, b as number]);
  }

  /** Run one tick of the round: queued commands, CPUs, then the battle itself. */
  tick(): void {
    const live = this.live;
    if (!live || this.s.phase !== "playing") return;
    const { battle, brains, rng } = live;
    const applied: Cmd[] = [];
    for (const cmd of live.queue) if (battle.apply(cmd)) applied.push(cmd);
    live.queue = [];
    const act = (cmd: Cmd) => {
      if (!battle.apply(cmd)) return false;
      applied.push(cmd);
      return true;
    };
    for (const p of this.s.players) {
      const brain = p.slot >= 0 ? brains[p.slot] : null;
      if (p.cpu && brain) think(battle, p.slot, brain, rng, act);
    }
    const events = battle.step();
    const frame: Frame = { t: "f", n: battle.n };
    if (applied.length) frame.c = applied;
    if (wantsChecksum(battle.n)) frame.ck = battle.checksum();
    this.outbox.push(frame);
    for (const ev of events) {
      if (ev.e !== "out") continue;
      const p = this.s.players.find((x) => x.slot === ev.slot);
      if (p) this.event(`${p.name} is out`);
    }
    if (battle.over) this.finish();
  }

  // ---------------------------------------------------------------- internals

  private slotOf(id: string): number {
    const p = this.player(id);
    if (!p || p.slot < 0 || !this.live || this.s.phase !== "playing") throw new GameError("You're not in this round");
    return p.slot;
  }

  private queue(cmd: Cmd): void {
    const why = this.live!.battle.check(cmd);
    if (why) throw new GameError(why);
    this.live!.queue.push(cmd);
  }

  private startRound(): void {
    const s = this.s;
    const seed = randomSeed();
    const rng = mulberry32(seed);
    const seated = this.participants.filter((p) => p.slot >= 0);
    const map = generateMap(seed, seated.length, s.settings.map);
    const battle = new Battle(map, {
      slots: seated.map((p) => p.slot),
      countdown: COUNTDOWN_TICKS,
      limit: s.settings.minutes * 60 * TICKS_PER_SEC,
    });
    const brains: (Brain | null)[] = Array(MAX_PLAYERS).fill(null);
    // CPUs take their first look at slightly different times.
    for (const p of seated) if (p.cpu) brains[p.slot] = newBrain(p.cpu, COUNTDOWN_TICKS + Math.floor(rng() * 8));
    this.live = { battle, brains, rng, queue: [] };
    s.phase = "playing";
    s.results = null;
    this.outbox.push({ t: "snap", snap: battle.snapshot() });
    this.touch();
  }

  private finish(): void {
    const s = this.s;
    const battle = this.live!.battle;
    const bySlot = new Map(this.participants.filter((p) => p.slot >= 0).map((p) => [p.slot, p]));
    const standings: Standing[] = battle
      .ranking()
      .map((slot) => ({ slot, p: bySlot.get(slot) }))
      .filter((x): x is { slot: number; p: PlayerState } => !!x.p)
      .map(({ slot, p }) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        cpu: !!p.cpu,
        bases: battle.basesOf(slot),
        units: battle.unitsOf(slot),
        taken: battle.taken[slot],
        best: battle.best[slot],
        alive: battle.alive(slot),
      }));
    const alive = standings.filter((x) => x.alive);
    const how = alive.length <= 1 ? "conquest" : "time";
    const [first, second] = standings;
    const clear =
      !!first &&
      first.alive &&
      (how === "conquest" || !second || first.bases > second.bases || (first.bases === second.bases && first.units > second.units));
    const winner = clear ? first : null;
    const result: RoundResult = { round: s.round, total: battle.bases.length, winnerId: winner?.id ?? null, how, standings };
    s.results = result;
    s.phase = "results";
    for (const p of s.players) p.slot = -1;
    if (winner) {
      this.player(winner.id)!.wins++;
      this.event(
        how === "conquest"
          ? `${winner.name} wins round ${s.round}: the last one standing!`
          : `${winner.name} wins round ${s.round} with ${winner.bases} of ${result.total} bases.`,
      );
    } else {
      this.event(`Round ${s.round} is a draw.`);
    }
    this.live = null;
    this.touch();
  }
}
