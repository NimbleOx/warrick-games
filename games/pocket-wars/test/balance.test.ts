import { it } from "vitest";
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { MAP_LIST } from "../src/shared/maps";
import { simulate } from "./sim";

// Seat balance between equal CPUs, for tuning SEAT_FUNDS and the maps. Off by default, since it
// plays hundreds of games: BALANCE=1 npx vitest run test/balance.test.ts (GAMES=40 for more).
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

it.skipIf(!env.BALANCE)("prints how often each seat wins", () => {
  const games = Number(env.GAMES ?? 20);
  for (const m of MAP_LIST) {
    for (const level of ["normal", "hard"] as CpuLevel[]) {
      const wins = Array(m.players + 1).fill(0);
      let days = 0;
      for (let seed = 1; seed <= games; seed++) {
        const r = simulate(m, Array(m.players).fill(level), seed * 7919, 100);
        wins[r.winner ?? m.players]++;
        days += r.days;
      }
      console.log(`${m.name}, ${level}: wins by seat ${wins.slice(0, -1).join(" / ")}, unfinished ${wins[m.players]}, ${Math.round(days / games)} days on average`);
    }
  }
}, 3_600_000);
