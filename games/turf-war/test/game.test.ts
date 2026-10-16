import { describe, expect, it } from "vitest";
import { COUNTDOWN_TICKS, TICKS_PER_SEC } from "../src/shared/constants";
import type { Frame, ServerMsg } from "../src/shared/protocol";
import { applyFrame, viewFromSnapshot } from "../src/shared/sim";
import { Game, GameError, newGameState, type Live } from "../src/worker/game";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  let live: Live | null = null;
  const sent: ServerMsg[] = [];
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  /** Like the Durable Object: a fresh Game per action, with the live round carried over. */
  const act = <T>(fn: (g: Game) => T): T => {
    const g = new Game(s, io, live);
    const out = fn(g);
    live = g.live;
    sent.push(...g.outbox);
    return out;
  };
  const human = (name: string) => {
    const p = act((g) => g.addHuman(name));
    connected.add(p.id);
    return p;
  };
  return {
    s,
    act,
    human,
    connected,
    sent,
    get live() {
      return live;
    },
    forget() {
      live = null;
    },
    advance(ms: number) {
      now += ms;
    },
    tickUntil(done: () => boolean, max = 10000) {
      for (let i = 0; i < max && !done(); i++) act((g) => g.tick());
    },
  };
}

describe("lobby", () => {
  it("makes the first human the host and needs two players to start", () => {
    const t = setup();
    const host = t.human("Ann");
    expect(t.s.hostId).toBe(host.id);
    expect(() => t.act((g) => g.start(host.id))).toThrow(GameError);
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    expect(t.s.phase).toBe("playing");
  });

  it("only lets the host change settings, and only to listed values", () => {
    const t = setup();
    const host = t.human("Ann");
    const guest = t.human("Bo");
    expect(() => t.act((g) => g.updateSettings(guest.id, { roundSeconds: 60 }))).toThrow("Only the host");
    t.act((g) => g.updateSettings(host.id, { roundSeconds: 60, board: "small" }));
    t.act((g) => g.updateSettings(host.id, { roundSeconds: 7 }));
    expect(t.s.settings).toEqual({ roundSeconds: 60, board: "small" });
  });

  it("fills up at eight and seats newcomers as spectators", () => {
    const t = setup();
    const host = t.human("Ann");
    for (let i = 0; i < 7; i++) t.act((g) => g.addCpu(host.id, "easy"));
    expect(() => t.act((g) => g.addCpu(host.id, "easy"))).toThrow("full");
    const late = t.human("Cy");
    expect(late.spectator).toBe(true);
    expect(new Set(t.s.players.map((p) => p.color)).size).toBe(8);
  });
});

describe("a round", () => {
  it("plays to the clock, ranks everyone by land and records the winner", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.updateSettings(host.id, { roundSeconds: 60 }));
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    expect(t.s.players.map((p) => p.slot)).toEqual([0, 1, 2]);
    expect(t.sent.some((m) => m.t === "snap")).toBe(true);

    let ticks = 0;
    t.tickUntil(() => {
      ticks++;
      return t.s.phase !== "playing";
    });
    expect(ticks - 1).toBe(COUNTDOWN_TICKS + 60 * TICKS_PER_SEC);
    expect(t.s.phase).toBe("results");
    const r = t.s.results!;
    expect(r.standings).toHaveLength(3);
    expect(r.standings[0].cells).toBeGreaterThanOrEqual(r.standings[1].cells);
    if (r.winnerId) expect(t.s.players.find((p) => p.id === r.winnerId)!.wins).toBe(1);
    expect(t.s.players.every((p) => p.slot === -1)).toBe(true);
    expect(t.live).toBeNull();

    // Play again straight from the results.
    t.act((g) => g.start(host.id));
    expect(t.s.phase).toBe("playing");
    expect(t.s.round).toBe(2);
  });

  it("puts a disconnected human on autopilot instead of letting them crash", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    t.connected.delete(host.id);
    t.tickUntil(() => t.s.phase !== "playing");
    const ann = t.s.results!.standings.find((x) => x.id === host.id)!;
    expect(ann.cells).toBeGreaterThan(0);
  });

  it("drops a late joiner into a free slot, and frees it when they leave", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    t.tickUntil(() => t.live!.round.n > COUNTDOWN_TICKS + 5);

    const late = t.human("Bo");
    expect(late.spectator).toBe(false);
    expect(late.slot).toBe(2);
    t.act((g) => g.tick());
    expect(t.live!.round.board.heads[2].alive).toBe(true);

    t.act((g) => g.leave(late.id));
    t.act((g) => g.tick());
    expect(t.live!.round.board.land[2]).toBe(0);
    expect(t.s.players.find((p) => p.id === late.id)).toBeUndefined();
    expect(t.live!.round.slotFree(2)).toBe(true);
  });

  it("starts a late joiner from scratch, not with the stats of their slot's last owner", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.updateSettings(host.id, { roundSeconds: 60 }));
    const bo = t.human("Bo");
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    t.tickUntil(() => t.live!.round.n > COUNTDOWN_TICKS + 20);
    const round = t.live!.round;
    expect(bo.slot).toBe(1);
    // Bo has had a busy round, and a client has been following it.
    round.kills[1] = 4;
    round.deaths[1] = 3;
    round.best[1] = 900;
    const view = viewFromSnapshot(JSON.parse(JSON.stringify(round.snapshot())))!;
    let seen = t.sent.length;
    const follow = () => {
      for (const m of t.sent.slice(seen)) {
        if (m.t === "f") expect(applyFrame(view, JSON.parse(JSON.stringify(m)) as Frame)).toBe(true);
      }
      seen = t.sent.length;
    };

    t.act((g) => g.leave(bo.id));
    t.act((g) => g.tick());
    const cy = t.human("Cy");
    expect(cy.slot).toBe(1);
    expect([round.kills[1], round.deaths[1], round.best[1]]).toEqual([0, 0, 0]);
    t.act((g) => g.tick());
    follow();
    expect(view.board.heads[1].alive).toBe(true);
    expect([view.kills[1], view.deaths[1]]).toEqual([0, 0]);

    let most = 0;
    t.tickUntil(() => {
      most = Math.max(most, round.board.land[1]);
      return t.s.phase !== "playing";
    });
    follow();
    expect([view.kills[1], view.deaths[1]]).toEqual([round.kills[1], round.deaths[1]]);
    const mine = t.s.results!.standings.find((x) => x.id === cy.id)!;
    expect(mine).toMatchObject({ best: most, kills: round.kills[1], deaths: round.deaths[1] });
    expect(mine.best).toBeLessThan(900);
  });

  it("refuses lobby changes mid-round, and turns from players without a seat", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    expect(() => t.act((g) => g.addCpu(host.id, "easy"))).toThrow("Wait for the round");
    expect(() => t.act((g) => g.updateSettings(host.id, { board: "large" }))).toThrow("Wait for the round");
    t.act((g) => g.turn("nobody", 1));
    t.act((g) => g.turn(host.id, 9));
  });

  it("starts the round over if the board was lost to a restart", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    t.tickUntil(() => t.live!.round.n > 100);
    t.forget();
    t.act((g) => g.recover());
    expect(t.live!.round.n).toBe(0);
    expect(t.s.round).toBe(1);
    expect(t.live!.round.board.heads.filter((h) => h.alive)).toHaveLength(2);
  });

  it("seats a newcomer whose hello is the first thing after a restart", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    t.tickUntil(() => t.live!.round.n > 100);
    t.forget();
    // The room adds the newcomer, then recovers the round (`afterHello`).
    const cy = t.act((g) => {
      const p = g.addHuman("Cy");
      g.recover();
      return p;
    });
    expect(cy.spectator).toBe(false);
    expect(cy.slot).toBe(2);
    const round = t.live!.round;
    expect(round.n).toBe(0);
    expect(round.inRound.slice(0, 3)).toEqual([true, true, true]);
    expect(round.board.heads[2].alive).toBe(true);
  });

  it("sends frames a client can follow from the round's snapshot", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.start(host.id));
    const snap = t.sent.find((m) => m.t === "snap")!;
    const view = viewFromSnapshot(JSON.parse(JSON.stringify(snap)).snap)!;
    t.tickUntil(() => t.live!.round.n >= 400);
    for (const m of t.sent) {
      if (m.t === "f") expect(applyFrame(view, JSON.parse(JSON.stringify(m)) as Frame)).toBe(true);
    }
    expect(view.board.checksum()).toBe(t.live!.round.board.checksum());
  });
});
