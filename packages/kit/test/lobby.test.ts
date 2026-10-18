import { describe, expect, it } from "vitest";
import type { BasePlayer, BaseState } from "../src/shared/protocol";
import { GameError, Lobby, baseState } from "../src/worker/lobby";

interface Player extends BasePlayer {
  wins: number;
}
type State = BaseState<Player, { speed: string; rounds: number }>;

/** The smallest game: start plays nothing, it just changes the phase. */
class TestGame extends Lobby<State> {
  protected readonly choices = { speed: ["slow", "fast"], rounds: [1, 3, 5] };
  protected createPlayer(base: BasePlayer): Player {
    return { ...base, wins: 0 };
  }
  start(byId: string): void {
    this.beginStart(byId);
    this.s.phase = "playing";
    this.touch();
  }
  /** A start for a game that can be played alone. */
  startAlone(byId: string): void {
    this.beginStart(byId, 1);
    this.s.phase = "playing";
    this.touch();
  }
  finish(): void {
    this.s.phase = "results";
    this.touch();
  }
}

function setup() {
  let now = 1000;
  const s: State = baseState("ABCDE", now, { speed: "slow", rounds: 3 });
  const connected = new Set<string>();
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  const game = () => new TestGame(s, io);
  const join = (name: string) => {
    const p = game().addHuman(name);
    connected.add(p.id);
    return p;
  };
  return { s, game, join, connected, advance: (ms: number) => (now += ms) };
}

describe("lobby", () => {
  it("makes the first player host and gives everyone a different colour", () => {
    const t = setup();
    const a = t.join("Ann");
    const b = t.join("Bo");
    expect(t.s.hostId).toBe(a.id);
    expect(a.color).not.toBe(b.color);
    expect(t.game().logs).toEqual([]);
  });

  it("cleans names", () => {
    const t = setup();
    expect(t.join("  Ann\u0007   the  Great Destroyer of Worlds ").name).toBe("Ann the Great De");
    expect(t.join("   ").name).toBe("Player 2");
  });

  it("only takes settings from the allowed choices, with their real types", () => {
    const t = setup();
    const host = t.join("Ann");
    t.game().updateSettings(host.id, { speed: "fast", rounds: "5", bogus: 1 });
    expect(t.s.settings).toEqual({ speed: "fast", rounds: 3 });
    t.game().updateSettings(host.id, { rounds: 5 });
    expect(t.s.settings.rounds).toBe(5);
  });

  it("keeps lobby controls for the host, until the host drops", () => {
    const t = setup();
    const host = t.join("Ann");
    const bo = t.join("Bo");
    expect(() => t.game().addCpu(bo.id, "easy")).toThrow(GameError);
    t.connected.delete(host.id);
    const g = t.game();
    g.addCpu(bo.id, "hard");
    expect(t.s.hostId).toBe(bo.id);
    expect(g.logs.map((l) => l.text)).toContain("Bo is now the host");
    expect(t.s.players.at(-1)).toMatchObject({ name: "CPU Rex", cpu: "hard", connected: false });
  });

  it("marks a new host as a change, even when the action that made them host fails", () => {
    const t = setup();
    const host = t.join("Ann");
    const bo = t.join("Bo");
    t.connected.delete(host.id);
    const g = t.game();
    expect(() => g.addCpu(bo.id, "impossible" as never)).toThrow("Unknown CPU level");
    expect(t.s.hostId).toBe(bo.id);
    expect(g.dirty).toBe(true);
  });

  it("swaps colours with whoever had the one you pick", () => {
    const t = setup();
    const a = t.join("Ann");
    const b = t.join("Bo");
    const [ca, cb] = [a.color, b.color];
    t.game().setColor(a.id, cb);
    expect(t.s.players.map((p) => p.color)).toEqual([cb, ca]);
    // Picking the colour you have changes nothing.
    const g = t.game();
    g.setColor(a.id, cb);
    expect(g.dirty).toBe(false);
  });

  it("starts with two players, drops humans who left, and closes the lobby during play", () => {
    const t = setup();
    const host = t.join("Ann");
    expect(() => t.game().start(host.id)).toThrow("Need at least two players");
    const gone = t.join("Bo");
    t.game().setConnected(gone.id, false);
    t.game().addCpu(host.id, "easy");
    t.game().start(host.id);
    expect(t.s.phase).toBe("playing");
    expect(t.s.players.map((p) => p.name)).toEqual(["Ann", "CPU Rex"]);
    expect(() => t.game().updateSettings(host.id, { speed: "fast" })).toThrow("Wait for the round to end");
    // Anyone arriving now watches.
    expect(t.join("Cy").spectator).toBe(true);
  });

  it("starts with one player in a game that can be played alone", () => {
    const t = setup();
    const host = t.join("Ann");
    const g = t.game();
    g.startAlone(host.id);
    expect(t.s.phase).toBe("playing");
    expect(g.participants.map((p) => p.name)).toEqual(["Ann"]);
  });

  it("leaves the lobby as it was when a start fails", () => {
    const t = setup();
    const host = t.join("Ann");
    const gone = t.join("Bo");
    t.game().setConnected(gone.id, false);
    const g = t.game();
    expect(() => g.start(host.id)).toThrow("Need at least two players — add a CPU?");
    expect(t.s.players.map((p) => p.name)).toEqual(["Ann", "Bo"]);
    expect(g.dirty).toBe(false);
  });

  it("goes back to the lobby only from a finished game, and seats watchers", () => {
    const t = setup();
    const host = t.join("Ann");
    t.game().addCpu(host.id, "easy");
    t.game().start(host.id);
    const late = t.join("Cy");
    expect(() => t.game().backToLobby(host.id)).toThrow("Not right now");
    t.game().finish();
    t.game().backToLobby(host.id);
    expect(t.s.phase).toBe("lobby");
    expect(t.s.players.find((p) => p.id === late.id)?.spectator).toBe(false);
  });

  it("hands the host on when the host leaves, and kicking reports humans", () => {
    const t = setup();
    const host = t.join("Ann");
    const bo = t.join("Bo");
    t.game().addCpu(host.id, "normal");
    const cpu = t.s.players.at(-1)!;
    expect(t.game().kick(host.id, cpu.id)).toBe(false);
    t.game().leave(host.id);
    expect(t.s.hostId).toBe(bo.id);
    expect(t.s.players.map((p) => p.name)).toEqual(["Bo"]);
  });
});
