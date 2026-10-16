import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed, type Rng } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState, type GameIO } from "@warrick/kit/worker/lobby";
import { newBrain, planTurn, think, type Brain } from "../shared/ai";
import { Battle, planned, wantsChecksum, type Cmd, type Frame } from "../shared/battle";
import {
  COUNTDOWN_TICKS,
  MAX_PLAN,
  PLAYER_COLORS,
  SEND_PCTS,
  TICKS_PER_SEC,
  TURN_TICKS,
  type SendPct,
} from "../shared/constants";
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
  type TurnState,
} from "../shared/protocol";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

/** Turns: once the only players still planning have dropped out, how long they get to come back. */
export const AWAY_MS = 15_000;
/** Turns: a plan deadline the room only noticed this long after it passed was missed while nobody was here. */
const LATE_MS = 5000;
/** An alarm can fire a moment early. A deadline this close counts as reached. */
const EARLY_MS = 25;

/**
 * Turns: the battle as one turn's planning began. The room saves it (and the plans, as they
 * change), so the round can come back after the object restarts or hibernates.
 */
export interface SavedRound {
  /** The round it belongs to (`GameState.round`). */
  round: number;
  turn: number;
  snap: Snapshot;
}

/**
 * The round being played. It changes every tick, so it lives in memory. In turns the room also
 * saves enough of it to bring it back (see `restore`).
 */
export interface Live {
  battle: Battle;
  /** CPU memory, by slot. */
  brains: (Brain | null)[];
  rng: Rng;
  /**
   * Commands to carry out at the start of the next tick. Real time: players' commands, checked
   * when they arrived. Turns: everyone's plans, as the turn starts to run.
   */
  queue: Cmd[];
  /** Turns: each slot's plan for this turn. */
  plans: Cmd[][];
  /** Turns: brought back mid-run, so the turn plays again from its start; the first hello says so. */
  replay?: boolean;
}

export function newGameState(code: string, now: number): GameState {
  return { ...baseState(code, now, DEFAULT_SETTINGS), round: 0, turn: null, results: null };
}

const noPlans = (): Cmd[][] => Array.from({ length: MAX_PLAYERS }, () => []);

/**
 * Turns: everyone's orders in the order they go out. A different player's go first each turn:
 * units that reach the same base on the same tick fight in the order they left.
 */
function runOrder(battle: Battle, turn: number, plans: Cmd[][]): Cmd[] {
  const slots = battle.aliveSlots();
  const k = slots.length ? (turn - 1) % slots.length : 0;
  return [...slots.slice(k), ...slots.slice(0, k)].flatMap((s) => plans[s]);
}

/**
 * Turns: the round back in memory when the object restarted (every deploy) or woke from
 * hibernation without it (nothing keeps it awake while everyone plans), from what the room saved:
 * the battle as this turn's planning began, and the plans. While planning, nothing is lost. While
 * running, the turn plays again from its start with the same orders. Null when there's nothing to
 * bring back: real time, no round, or a save from another turn.
 */
export function restore(s: GameState, saved: SavedRound | null, plans: Cmd[][] | null): Live | null {
  const turn = s.phase === "playing" ? s.turn : null;
  if (!turn || !saved || saved.round !== s.round || saved.turn !== turn.n) return null;
  const battle = Battle.fromSnapshot(saved.snap);
  const seated = s.players.filter((p) => !p.spectator && p.slot >= 0);
  // Anyone who left since it was saved leaves this battle too.
  for (let slot = 0; slot < MAX_PLAYERS; slot++) {
    if (battle.inRound(slot) && !seated.some((p) => p.slot === slot)) battle.leave(slot);
  }
  const brains: (Brain | null)[] = Array(MAX_PLAYERS).fill(null);
  for (const p of seated) if (p.cpu) brains[p.slot] = newBrain(p.cpu);
  const live: Live = { battle, brains, rng: mulberry32(randomSeed()), queue: [], plans: noPlans() };
  plans?.forEach((plan, slot) => slot < MAX_PLAYERS && (live.plans[slot] = [...plan]));
  if (turn.stage === "run") {
    live.queue = runOrder(battle, turn.n, live.plans);
    live.plans = noPlans();
    live.replay = true;
  }
  return live;
}

/**
 * Base Jump's rules on top of the kit's lobby: starting rounds, players' commands, the tick
 * (CPUs, then the battle) and the results. In real time, commands go in as they come. In turns,
 * everyone plans their orders at once; when all are done (or time's up) the battle runs for a
 * few seconds, then everyone plans again.
 */
export class Game extends Lobby<GameState, ServerMsg, Live> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly colors = PLAYER_COLORS;

  constructor(s: GameState, io: GameIO, live: Live | null = null) {
    super(s, io, live);
    // Games saved before there were turns have neither the setting nor the field.
    if (s.settings.mode === undefined) s.settings = { ...DEFAULT_SETTINGS, ...s.settings };
    s.turn ??= null;
  }

  protected createPlayer(base: BasePlayer): PlayerState {
    return { ...base, slot: -1, wins: 0 };
  }

  /** A player left mid-round: their bases go neutral, and everyone gets the battle as it is now. */
  leave(id: string): void {
    const p = this.player(id);
    const slot = p?.slot ?? -1;
    const live = this.live;
    if (slot >= 0 && live) {
      live.battle.leave(slot);
      live.plans[slot] = [];
      this.outbox.push({ t: "snap", snap: live.battle.snapshot() });
    }
    super.leave(id);
    if (slot < 0 || !live || this.s.phase !== "playing") return;
    if (live.battle.over) this.finish();
    else this.review();
  }

  /** Turns: nobody waits long for a player who has gone. */
  setConnected(id: string, connected: boolean): void {
    super.setConnected(id, connected);
    this.review();
  }

  /** Start a round, from the lobby or from the last round's results. */
  start(byId: string): void {
    this.beginStart(byId);
    this.s.round++;
    this.participants.forEach((p, i) => (p.slot = i));
    this.startRound();
    this.announce();
  }

  protected resetForLobby(): void {
    this.s.results = null;
    this.s.turn = null;
  }

  /**
   * The room restarted mid-round and the battle was lost, with nothing saved to bring it back
   * (`restore`): play the round again on a new map.
   */
  recover(): void {
    if (this.s.phase !== "playing" || this.live) return;
    this.event(`The server restarted, so round ${this.s.round} starts over`);
    this.startRound();
  }

  /** Someone said hello: start over a round that was lost, and give them back their plan. */
  greet(id: string): void {
    this.recover();
    const live = this.live;
    if (live?.replay && this.s.turn) {
      live.replay = false;
      this.event(`The server restarted, so turn ${this.s.turn.n} plays again from the start`);
    }
    const p = this.player(id);
    if (p && p.slot >= 0 && this.s.turn?.stage === "plan") this.sendPlan(id, p.slot);
  }

  snapshot(): Snapshot | null {
    return this.live?.battle.snapshot() ?? null;
  }

  /** Send units. */
  send(id: string, from: unknown, to: unknown, pct: unknown): void {
    const slot = this.slotOf(id);
    const list = Array.isArray(from) ? from.filter((b): b is number => Number.isInteger(b)).slice(0, 80) : [];
    if (!Number.isInteger(to) || !SEND_PCTS.includes(pct as SendPct)) throw new GameError("That's not a move");
    this.order(id, slot, ["s", slot, list, to as number, pct as SendPct]);
  }

  upgrade(id: string, b: unknown): void {
    const slot = this.slotOf(id);
    if (!Number.isInteger(b)) throw new GameError("That's not a base");
    this.order(id, slot, ["u", slot, b as number]);
  }

  /** Turns: take back the last order in the plan. */
  undo(id: string): void {
    const slot = this.slotOf(id);
    this.planning(slot);
    const plan = this.live!.plans[slot];
    if (!plan.length) throw new GameError("There are no orders to take back");
    plan.pop();
    this.notDone(id);
    this.sendPlan(id, slot);
  }

  /** Turns: finished planning (the turn runs once everyone is), or not after all. */
  done(id: string, done: unknown): void {
    const turn = this.planning(this.slotOf(id));
    const now = done === true;
    if (now === turn.done.includes(id)) return;
    turn.done = now ? [...turn.done, id] : turn.done.filter((x) => x !== id);
    this.touch();
    this.review();
  }

  /** Run one tick of the round: queued commands, CPUs (in real time), then the battle itself. */
  tick(): void {
    const live = this.live;
    if (!live || this.s.phase !== "playing") return;
    const turn = this.s.turn;
    if (turn && turn.stage !== "run") return;
    const { battle, brains, rng } = live;
    const applied: Cmd[] = [];
    for (const cmd of live.queue) if (battle.apply(cmd)) applied.push(cmd);
    live.queue = [];
    if (!turn) {
      const act = (cmd: Cmd) => {
        if (!battle.apply(cmd)) return false;
        applied.push(cmd);
        return true;
      };
      for (const p of this.s.players) {
        const brain = p.slot >= 0 ? brains[p.slot] : null;
        if (p.cpu && brain) think(battle, p.slot, brain, rng, act);
      }
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
    else if (turn && battle.n >= turn.tick + TURN_TICKS) this.beginPlan(turn.n + 1);
  }

  /** Turns: time to plan is up, so the turn runs with whatever everyone has planned. */
  onTimer(): void {
    const turn = this.s.turn;
    if (!this.live || this.s.phase !== "playing" || turn?.stage !== "plan" || turn.deadline === null) return;
    const now = this.io.now();
    if (now < turn.deadline - EARLY_MS) return;
    if (now - turn.deadline > LATE_MS) {
      // Time ran out while nobody was here: whoever is back gets the whole time to plan.
      const secs = this.s.settings.plan;
      turn.end = turn.deadline = secs ? now + secs * 1000 : null;
      this.touch();
      this.review();
      return;
    }
    this.runTurn();
  }

  // ---------------------------------------------------------------- internals

  private slotOf(id: string): number {
    const p = this.player(id);
    if (!p || p.slot < 0 || !this.live || this.s.phase !== "playing") throw new GameError("You're not in this round");
    return p.slot;
  }

  /** Turns, and planning now: the turn. Says why not otherwise. */
  private planning(slot: number): TurnState {
    const turn = this.s.turn;
    if (!turn) throw new GameError("This round is in real time");
    if (!this.live!.battle.alive(slot)) throw new GameError("You're out of this round");
    if (turn.stage !== "plan") throw new GameError("Wait for this turn to play out");
    return turn;
  }

  /**
   * Real time: checked now, so a mistake comes straight back, and carried out on the next tick.
   * Turns: checked against the battle as the player's plan so far would leave it, then added to it.
   */
  private order(id: string, slot: number, cmd: Cmd): void {
    const live = this.live!;
    if (!this.s.turn) {
      const why = live.battle.check(cmd);
      if (why) throw new GameError(why);
      live.queue.push(cmd);
      return;
    }
    this.planning(slot);
    const plan = live.plans[slot];
    if (plan.length >= MAX_PLAN) throw new GameError(`That's ${MAX_PLAN} orders, the most for one turn`);
    const why = planned(live.battle, plan).check(cmd);
    if (why) throw new GameError(why);
    plan.push(cmd);
    this.notDone(id);
    this.sendPlan(id, slot);
  }

  private sendPlan(id: string, slot: number): void {
    const turn = this.s.turn;
    if (turn) this.direct.push({ pid: id, msg: { t: "plan", n: turn.n, c: [...this.live!.plans[slot]] } });
  }

  /** A player who changes their plan isn't done any more. */
  private notDone(id: string): void {
    const turn = this.s.turn;
    if (!turn?.done.includes(id)) return;
    turn.done = turn.done.filter((x) => x !== id);
    this.touch();
  }

  /** Turns: everyone plans afresh. CPUs make their plans at once. */
  private beginPlan(n: number): void {
    const live = this.live!;
    const { battle, brains, rng } = live;
    const secs = this.s.settings.plan;
    const end = secs ? this.io.now() + secs * 1000 : null;
    this.s.turn = { n, stage: "plan", tick: battle.n, end, deadline: end, done: [] };
    live.plans = noPlans();
    for (const p of this.participants) {
      const brain = p.slot >= 0 ? brains[p.slot] : null;
      if (p.cpu && brain) live.plans[p.slot] = planTurn(battle, p.slot, brain.level, rng);
    }
    this.touch();
    this.review();
  }

  /**
   * Turns: run the turn once every player still in has finished planning. Once the only ones
   * still planning have dropped out, they get `AWAY_MS` to come back (a reload, or a phone
   * switching apps), and then the turn runs without them.
   */
  private review(): void {
    const live = this.live;
    const turn = this.s.turn;
    if (!live || this.s.phase !== "playing" || turn?.stage !== "plan") return;
    const waiting = this.participants.filter(
      (p) => !p.cpu && p.slot >= 0 && live.battle.alive(p.slot) && !turn.done.includes(p.id),
    );
    if (!waiting.length) return this.runTurn();
    let deadline = turn.end;
    if (!waiting.some((p) => p.connected)) {
      // A grace period that's already running carries on.
      const grace = turn.deadline !== null && turn.deadline !== turn.end ? turn.deadline : this.io.now() + AWAY_MS;
      deadline = Math.min(grace, turn.end ?? Infinity);
    }
    if (deadline === turn.deadline) return;
    turn.deadline = deadline;
    this.touch();
  }

  /** Turns: everyone's plans go into the queue for the next tick, and the battle runs. */
  private runTurn(): void {
    const live = this.live!;
    const turn = this.s.turn!;
    live.queue = runOrder(live.battle, turn.n, live.plans);
    live.plans = noPlans();
    turn.stage = "run";
    turn.end = turn.deadline = null;
    turn.done = [];
    this.touch();
  }

  private announce(): void {
    const { mode, minutes, turns, plan } = this.s.settings;
    const bases = `${this.live!.battle.bases.length} bases`;
    if (mode === "turns") {
      const limit = turns ? `${turns} turns` : "no turn limit";
      const clock = plan ? `${plan} seconds to plan each` : "no time limit to plan";
      this.event(`Round ${this.s.round}: ${bases}, ${limit}, ${clock}. Plan your first move!`);
    } else {
      const limit = minutes ? `${minutes} minutes on the clock` : "no time limit";
      this.event(`Round ${this.s.round}: ${bases}, ${limit}. Go!`);
    }
  }

  private startRound(): void {
    const s = this.s;
    const turns = s.settings.mode === "turns";
    const seed = randomSeed();
    const rng = mulberry32(seed);
    const seated = this.participants.filter((p) => p.slot >= 0);
    const map = generateMap(seed, seated.length, s.settings.map);
    const battle = new Battle(map, {
      slots: seated.map((p) => p.slot),
      countdown: turns ? 0 : COUNTDOWN_TICKS,
      limit: turns ? s.settings.turns * TURN_TICKS : s.settings.minutes * 60 * TICKS_PER_SEC,
    });
    const brains: (Brain | null)[] = Array(MAX_PLAYERS).fill(null);
    // In real time, CPUs take their first look at slightly different times.
    for (const p of seated) if (p.cpu) brains[p.slot] = newBrain(p.cpu, COUNTDOWN_TICKS + Math.floor(rng() * 8));
    this.live = { battle, brains, rng, queue: [], plans: noPlans() };
    s.phase = "playing";
    s.results = null;
    s.turn = null;
    this.outbox.push({ t: "snap", snap: battle.snapshot() });
    if (turns) this.beginPlan(1);
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
      (how === "conquest" ||
        !second ||
        first.bases > second.bases ||
        (first.bases === second.bases && first.units > second.units));
    const winner = clear ? first : null;
    const result: RoundResult = { round: s.round, total: battle.bases.length, winnerId: winner?.id ?? null, how, standings };
    if (s.turn) result.turns = s.turn.n;
    s.results = result;
    s.phase = "results";
    s.turn = null;
    for (const p of s.players) p.slot = -1;
    if (winner) {
      this.player(winner.id)!.wins++;
      const end = result.turns ? "when the last turn ends" : "when time runs out";
      this.event(
        how === "conquest"
          ? `${winner.name} wins round ${s.round}: the last one standing!`
          : `${winner.name} wins round ${s.round} with ${winner.bases} of ${result.total} bases ${end}.`,
      );
    } else {
      this.event(`Round ${s.round} is a draw.`);
    }
    this.live = null;
    this.touch();
  }
}
