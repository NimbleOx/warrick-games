import { describe, expect, it } from "vitest";
import { Arena, type ArenaConfig, type Dir } from "../src/shared/arena";
import { TurnCue } from "../src/client/turns";

const CFG: ArenaConfig = { w: 40, h: 40, walls: "solid", boosts: 0, boostTicks: 3, suddenDeathAt: 0, shrinkEvery: 1 };

/** A server arena, a client replaying its frames, and the client's cue, with one cycle heading right. */
function setup() {
  const server = Arena.create(CFG, [{ id: "me", x: 10, y: 20, dir: 1 }]);
  const client = new Arena(server.snapshot());
  const cue = new TurnCue();
  const send = (dir: Dir) => {
    server.queueTurn(0, dir);
    return cue.send(dir, client.cycles[0].dir, client.tick);
  };
  const show = () => {
    const f = server.step();
    const before = client.cycles[0].dir;
    client.apply(f);
    cue.shown(before, client.cycles[0].dir, f.n);
  };
  return { server, client, cue, send, show };
}

describe("turn cue", () => {
  it("shows a turn until the frame that makes it", () => {
    const { cue, send, show } = setup();
    expect(send(0)).toBe(true);
    expect(cue.next).toBe(0);
    show();
    expect(cue.next).toBe(null);
  });

  it("walks through a hairpin one turn per frame", () => {
    const { cue, client, send, show } = setup();
    send(0);
    send(3);
    show();
    expect(client.cycles[0].dir).toBe(0);
    expect(cue.next).toBe(3);
    show();
    expect(cue.next).toBe(null);
  });

  it("ignores the turns the server ignores", () => {
    const cue = new TurnCue();
    expect(cue.send(1, 1, 0)).toBe(false); // straight ahead
    expect(cue.send(3, 1, 0)).toBe(false); // U-turn
    expect(cue.send(0, 1, 0)).toBe(true);
    expect(cue.send(2, 1, 0)).toBe(false); // U-turn from the turn on its way
    expect(cue.send(3, 1, 0)).toBe(true); // a hairpin is fine
    expect(cue.send(2, 1, 0)).toBe(true);
    expect(cue.send(1, 1, 0)).toBe(false); // three already queued
    expect(cue.next).toBe(0);
  });

  it("drops a turn the server turned down once it's long overdue", () => {
    const { server, client, cue, show } = setup();
    cue.send(0, client.cycles[0].dir, client.tick); // never reaches the server
    for (let n = 0; n < 5; n++) show();
    expect(cue.next).toBe(0);
    for (let n = 0; n < 10; n++) show();
    expect(cue.next).toBe(null);
    expect(server.cycles[0].dir).toBe(1);
  });

  it("starts over after a turn it wasn't expecting", () => {
    const { server, client, cue, show } = setup();
    cue.send(0, client.cycles[0].dir, client.tick);
    server.queueTurn(0, 2);
    show();
    expect(client.cycles[0].dir).toBe(2);
    expect(cue.next).toBe(null);
  });
});
