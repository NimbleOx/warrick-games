import type { GameState } from "./protocol";
import { World, type SimTankInit } from "./sim";

/**
 * Build the simulation world for the current game state. Server and clients
 * must build it identically (same tank order and fields) for shots to replay
 * the same way on both.
 */
export function worldFromState(s: GameState): World {
  const tanks: SimTankInit[] = [];
  for (const p of s.players) {
    if (!p.tank) continue;
    tanks.push({ id: p.id, ...p.tank, parachutes: p.inventory.parachute ?? 0 });
  }
  return new World({ heights: s.terrain, tanks, wind: s.wind, walls: s.settings.walls });
}
