import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randInt, randomSeed } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState } from "@warrick/kit/worker/lobby";
import { Match } from "../shared/ai";
import { Arena, arenaSize, type ArenaEvent } from "../shared/arena";
import { THEME_COUNT, TICK_MS } from "../shared/constants";
import {
  CRATE_DENSITY,
  DEFAULT_SETTINGS,
  ITEM_RATE,
  SETTING_CHOICES,
  rankPlayers,
  type GameState,
  type PlayerState,
  type ServerMsg,
} from "../shared/protocol";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

/** The round being played: its arena and the CPU brains. It changes every tick, so it lives in memory only. */
export type Live = Match;

const CPU_NAMES = ["Fuse", "Blinky", "Kaboom", "Pixel", "Dynamo", "Sparky", "Boomer", "Wick", "Cinder", "Pop"];
const ROUNDOVER_MS = 4500;

export function newGameState(code: string, now: number): GameState {
  return {
    ...baseState(code, now, DEFAULT_SETTINGS),
    round: 0,
    roundWinnerId: null,
    phaseDeadline: null,
    timer: null,
  };
}

/**
 * Boom Room's rules on top of the kit's lobby: starting and scoring rounds, the tick that runs
 * the arena, and the pause between rounds. The lobby is only open in the "lobby" phase, and a
 * finished game sits in "gameover" until the host takes everyone back.
 */
export class Game extends Lobby<GameState, ServerMsg, Live> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly cpuNames = CPU_NAMES;
  protected readonly finishedPhase = "gameover";

  protected betweenRounds(): boolean {
    return this.s.phase === "lobby";
  }

  protected createPlayer(base: BasePlayer): PlayerState {
    // CPUs count as connected too.
    return { ...base, connected: true, wins: 0, kills: 0, deaths: 0, items: 0, inRound: false };
  }

  // ---------------------------------------------------------------- players

  /** Leaving mid-game keeps your place in the standings; your bomber sits out the rounds to come. */
  leave(id: string): void {
    const p = this.player(id);
    if (!p) return;
    if (this.s.phase === "lobby" || p.spectator) {
      this.removePlayer(id);
      this.event(`${p.name} left`);
    } else {
      this.event(`${p.name} left the game`);
      this.setConnected(id, false);
    }
  }

  // ---------------------------------------------------------------- match flow

  start(byId: string): void {
    this.requireHost(byId);
    this.requirePhase("lobby");
    // Players who closed their tab in the lobby don't hold up the game.
    for (const p of [...this.s.players]) {
      if (!p.cpu && !p.connected) this.removePlayer(p.id);
    }
    if (this.participants.length < 2) throw new GameError("Need at least two bombers — add a CPU?");
    for (const p of this.s.players) {
      p.wins = p.kills = p.deaths = p.items = 0;
      p.inRound = false;
    }
    this.s.round = 0;
    const n = this.s.settings.wins;
    this.event(`Game on! First to ${n} win${n > 1 ? "s" : ""}.`);
    this.startRound();
  }

  protected resetForLobby(): void {
    const s = this.s;
    s.round = 0;
    s.roundWinnerId = null;
    s.phaseDeadline = null;
    s.timer = null;
    this.live = null;
    for (const p of s.players) p.inRound = false;
  }

  /** With `again`, the bombers of the round that was lost play it again (nobody is connected yet after a restart). */
  private startRound(again = false): void {
    const s = this.s;
    // Bombers whose players have gone sit the round out rather than standing there as targets.
    const roster = this.participants.filter((p) => p.cpu || p.connected || (again && p.inRound));
    if (roster.length < 2) {
      this.event("Not enough bombers left to play on");
      this.gameOver();
      return;
    }
    const seed = randomSeed();
    const rng = mulberry32(seed);
    s.round++;
    s.phase = "playing";
    s.roundWinnerId = null;
    s.phaseDeadline = null;
    s.timer = null;
    for (const p of s.players) p.inRound = roster.includes(p);

    const arena = new Arena(
      rng,
      roster.map((p) => p.id),
      {
        ...arenaSize(roster.length),
        crates: CRATE_DENSITY[s.settings.crates],
        items: ITEM_RATE[s.settings.items],
        skulls: s.settings.skulls,
        hurryMs: s.settings.hurrySeconds ? s.settings.hurrySeconds * 1000 : null,
        theme: randInt(rng, 0, THEME_COUNT - 1),
      },
    );
    const cpus = roster.filter((p) => p.cpu).map((p) => ({ id: p.id, level: p.cpu! }));
    this.live = new Match(arena, cpus, rng);
    this.event(`Round ${s.round}`);
    this.touch();
    // A new round goes out with its first frame, right after the state, so clients never see
    // the round without the arena. (This message carries the state, so the room sends no other.)
    this.outbox.push({ t: "state", state: s, now: this.io.now() }, { t: "frame", f: arena.snapshot(false) });
  }

  /** The room lost its in-memory round (the object restarted): deal a fresh one. */
  restartRound(): void {
    if (this.s.phase !== "playing" || this.live) return;
    this.s.round = Math.max(0, this.s.round - 1);
    this.event("The round was interrupted — starting it again");
    this.startRound(true);
  }

  /** A player's own move (and bomb), straight into the arena. */
  move(id: string, x: unknown, y: unknown, d: unknown, bomb: boolean): void {
    const arena = this.live?.arena;
    if (!arena || this.s.phase !== "playing") return;
    arena.clientMove(id, x, y, d);
    if (bomb) arena.placeBomb(id);
  }

  /** One step of the arena, on the room's tick: send everyone the frame, and score the round once it's decided. */
  tick(): void {
    const m = this.live;
    if (!m || this.s.phase !== "playing") return;
    if (!m.arena.result) m.step(TICK_MS);
    const frame = m.arena.snapshot(true);
    this.outbox.push({ t: "frame", f: frame });
    this.onArenaEvents(frame.ev);
    if (m.arena.result) this.roundOver();
  }

  /** Narrate what happened in the arena this tick. */
  onArenaEvents(events: ArenaEvent[]): void {
    for (const ev of events) {
      if (ev.e === "die") {
        const victim = this.player(ev.id);
        if (!victim) continue;
        const killer = ev.by ? this.player(ev.by) : undefined;
        if (!ev.by) this.event(`🧱 ${victim.name} got squashed`);
        else if (ev.by === ev.id) this.event(`💥 ${victim.name} blew themselves up`);
        else if (killer) this.event(`💥 ${killer.name} blew up ${victim.name}`);
      } else if (ev.e === "hurry") {
        this.event("⏰ Hurry up! The walls are closing in");
      }
    }
  }

  /** The arena has a result: score the round. */
  roundOver(): void {
    const arena = this.live?.arena;
    if (this.s.phase !== "playing" || !arena?.result) return;
    const s = this.s;
    for (const ap of arena.players) {
      const p = this.player(ap.id);
      if (!p) continue;
      p.kills += ap.kills;
      p.items += ap.items;
      if (!ap.alive) p.deaths++;
    }
    const winner = this.player(arena.result.winner ?? "");
    if (winner) {
      winner.wins++;
      this.event(`🏆 ${winner.name} wins round ${s.round}`);
    } else {
      this.event(`Round ${s.round} is a draw`);
    }
    s.phase = "roundover";
    s.roundWinnerId = winner?.id ?? null;
    s.phaseDeadline = this.io.now() + ROUNDOVER_MS;
    s.timer = { kind: "roundover", at: s.phaseDeadline };
    this.touch();
  }

  private afterRoundOver(): void {
    const champion = this.participants.find((p) => p.wins >= this.s.settings.wins);
    if (champion) this.gameOver();
    else this.startRound();
  }

  private gameOver(): void {
    const s = this.s;
    s.phase = "gameover";
    s.phaseDeadline = null;
    s.timer = null;
    this.live = null;
    const best = [...this.participants].sort(rankPlayers)[0];
    if (best) this.event(`🎉 ${best.name} wins the game!`);
    this.touch();
  }

  // ---------------------------------------------------------------- timers

  onTimer(): void {
    const s = this.s;
    const t = s.timer;
    if (!t || this.io.now() < t.at - 25) return;
    s.timer = null;
    if (t.kind === "roundover" && s.phase === "roundover") this.afterRoundOver();
    this.touch();
  }
}
